import express from "express";
import cors from "cors";
import {
  createPublicClient,
  encodePacked,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiParameters,
  recoverAddress,
  getAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { KmsSignerService } from "./services/kmsSigner.js";
import { PersistenceService } from "./services/persistence.js";
import { createRequestContext, getLatencyMs } from "./services/requestContext.js";
import { logger } from "./services/logger.js";
import { assertSignValidityWindow, isValidationError } from "./services/validation.js";
import { emitCountMetric } from "./services/metrics.js";
import {
  publishSwapCompleted,
  publishTransactionFailed,
  publishWalletActivated,
} from "./services/eventPublisher.js";
import { getRoutingAdvisory, type RoutingAdvisory } from "./services/aiRouter.js";

dotenv.config();

const app = express();

const LEGACY_EDGE_API_KEY = process.env.EDGE_API_KEY?.trim();
const EDGE_SIGN_API_KEY = process.env.EDGE_SIGN_API_KEY?.trim() || LEGACY_EDGE_API_KEY;
const EDGE_TOPUP_API_KEY = process.env.EDGE_TOPUP_API_KEY?.trim() || LEGACY_EDGE_API_KEY;
const SIGN_RATE_LIMIT_PER_MINUTE = Number.parseInt(
  process.env.SIGN_RATE_LIMIT_PER_MINUTE ?? "60",
  10
);
const TOPUP_RATE_LIMIT_PER_MINUTE = Number.parseInt(
  process.env.TOPUP_RATE_LIMIT_PER_MINUTE ?? "30",
  10
);

const corsOriginValues = (process.env.CORS_ORIGINS ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const isWildcardCors = corsOriginValues.includes("*");
const allowedCorsOrigins = new Set(corsOriginValues.filter((origin) => origin !== "*"));

type RateLimitEntry = {
  count: number;
  expiresAtMs: number;
};

const rateLimitStore = new Map<string, RateLimitEntry>();

function getClientIdentifier(req: express.Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim() !== "") {
    return forwardedFor.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function createRateLimiter(options: { scope: string; maxPerMinute: number }): express.RequestHandler {
  if (!Number.isFinite(options.maxPerMinute) || options.maxPerMinute <= 0) {
    return (_req, _res, next) => next();
  }

  const windowMs = 60_000;

  return (req, res, next) => {
    const nowMs = Date.now();
    const key = `${options.scope}:${getClientIdentifier(req)}`;
    const current = rateLimitStore.get(key);

    if (!current || current.expiresAtMs <= nowMs) {
      rateLimitStore.set(key, { count: 1, expiresAtMs: nowMs + windowMs });
      return next();
    }

    if (current.count >= options.maxPerMinute) {
      emitCountMetric("UserOperationSubmissionFailure", 1, {
        endpoint: req.path,
      });

      res.setHeader("retry-after", Math.ceil((current.expiresAtMs - nowMs) / 1000).toString());
      return res.status(429).json({
        error: "rate_limit_exceeded",
        message: "Too many requests, please retry later",
      });
    }

    current.count += 1;
    rateLimitStore.set(key, current);
    return next();
  };
}

const signRateLimiter = createRateLimiter({
  scope: "sign",
  maxPerMinute: SIGN_RATE_LIMIT_PER_MINUTE,
});
const topupRateLimiter = createRateLimiter({
  scope: "topup",
  maxPerMinute: TOPUP_RATE_LIMIT_PER_MINUTE,
});

function requireScopedApiKey(requiredKey?: string): express.RequestHandler {
  return (req, res, next) => {
    if (!requiredKey) {
      return next();
    }

    const keyHeader = req.headers["x-api-key"];
    const presentedKey = typeof keyHeader === "string" ? keyHeader.trim() : "";

    if (presentedKey === requiredKey) {
      return next();
    }

    emitCountMetric("UserOperationSubmissionFailure", 1, {
      endpoint: req.path,
    });

    return res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid API key",
    });
  };
}

const requireSignApiKey = requireScopedApiKey(EDGE_SIGN_API_KEY);
const requireTopupApiKey = requireScopedApiKey(EDGE_TOPUP_API_KEY);

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isWildcardCors || allowedCorsOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("cors_origin_not_allowed"));
    },
  })
);

// =====================================================
// Runtime configuration
// =====================================================
const FAUCET_SIGNER_PRIVATE_KEY = process.env.FAUCET_SIGNER_PRIVATE_KEY as Hex | undefined;
const FAUCET_SIGNER_SECRET_ARN = process.env.FAUCET_SIGNER_SECRET_ARN;
const KMS_KEY_ID = process.env.KMS_KEY_ID;
const PAYMASTER_SIGNER_ADDRESS = process.env.PAYMASTER_SIGNER_ADDRESS as Address | undefined;
const RPC_URL = process.env.RPC_URL;
const RPC_URL_ETHERLINK = process.env.RPC_URL_ETHERLINK;
const STABLE_SWAP_ADDRESS = process.env.STABLE_SWAP_ADDRESS as Address | undefined;
const STABLE_SWAP_ADDRESS_ETHERLINK = process.env.STABLE_SWAP_ADDRESS_ETHERLINK as Address | undefined;
const IDRX_TOKEN_ADDRESS = process.env.IDRX_TOKEN_ADDRESS as Address | undefined;
const IDRX_TOKEN_ADDRESS_ETHERLINK = process.env.IDRX_TOKEN_ADDRESS_ETHERLINK as Address | undefined;
const ENTRY_POINT_ADDRESS = process.env.ENTRY_POINT_ADDRESS as Address | undefined;
const ENTRY_POINT_ADDRESS_ETHERLINK = process.env.ENTRY_POINT_ADDRESS_ETHERLINK as Address | undefined;

if (!RPC_URL) {
  console.warn("WARN: RPC_URL not found in .env; Base chain swap routes will be unavailable.");
}

if (!STABLE_SWAP_ADDRESS) {
  console.warn("WARN: STABLE_SWAP_ADDRESS not found in .env; Base chain swap routes will be unavailable.");
}

if (!RPC_URL_ETHERLINK || !STABLE_SWAP_ADDRESS_ETHERLINK) {
  console.warn("WARN: Etherlink is not configured (RPC_URL_ETHERLINK / STABLE_SWAP_ADDRESS_ETHERLINK missing).");
}

if (!KMS_KEY_ID) {
  console.warn("WARN: KMS_KEY_ID is not configured; /sign endpoint will reject requests.");
}

if (!PAYMASTER_SIGNER_ADDRESS) {
  console.warn("WARN: PAYMASTER_SIGNER_ADDRESS is not configured; /sign endpoint will reject requests.");
}

if (!FAUCET_SIGNER_PRIVATE_KEY && !FAUCET_SIGNER_SECRET_ARN) {
  console.warn(
    "WARN: FAUCET signer is not configured (set FAUCET_SIGNER_PRIVATE_KEY for local dev or FAUCET_SIGNER_SECRET_ARN in cloud); /topup-idrx endpoint will reject requests."
  );
}

if (process.env.PAYMASTER_SIGNER_PRIVATE_KEY) {
  console.warn("WARN: PAYMASTER_SIGNER_PRIVATE_KEY is deprecated and ignored.");
}

if (!EDGE_SIGN_API_KEY && !EDGE_TOPUP_API_KEY) {
  console.warn("WARN: EDGE_SIGN_API_KEY / EDGE_TOPUP_API_KEY not configured; sensitive routes rely on IAM/app-level controls only.");
}

const secretsManagerClient = FAUCET_SIGNER_SECRET_ARN
  ? new SecretsManagerClient({ region: process.env.AWS_REGION })
  : undefined;

let cachedFaucetSignerAccount: ReturnType<typeof privateKeyToAccount> | undefined;
let faucetSignerLoadPromise: Promise<ReturnType<typeof privateKeyToAccount> | undefined> | undefined;

function normalizePrivateKey(candidate: string): Hex | undefined {
  const trimmed = candidate.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed as Hex;
  }
  return undefined;
}

function parsePrivateKeyFromSecret(secretString: string): Hex | undefined {
  const asRaw = normalizePrivateKey(secretString);
  if (asRaw) {
    return asRaw;
  }

  try {
    const parsed = JSON.parse(secretString) as {
      privateKey?: string;
      faucetSignerPrivateKey?: string;
    };
    if (typeof parsed.privateKey === "string") {
      return normalizePrivateKey(parsed.privateKey);
    }
    if (typeof parsed.faucetSignerPrivateKey === "string") {
      return normalizePrivateKey(parsed.faucetSignerPrivateKey);
    }
  } catch {
    // Secret might be plain text; ignore JSON parsing errors.
  }

  return undefined;
}

async function getFaucetSignerAccount(): Promise<ReturnType<typeof privateKeyToAccount> | undefined> {
  if (cachedFaucetSignerAccount) {
    return cachedFaucetSignerAccount;
  }

  if (!faucetSignerLoadPromise) {
    faucetSignerLoadPromise = (async () => {
      const inlinePrivateKey =
        typeof FAUCET_SIGNER_PRIVATE_KEY === "string"
          ? normalizePrivateKey(FAUCET_SIGNER_PRIVATE_KEY)
          : undefined;

      if (inlinePrivateKey) {
        cachedFaucetSignerAccount = privateKeyToAccount(inlinePrivateKey);
        return cachedFaucetSignerAccount;
      }

      if (!secretsManagerClient || !FAUCET_SIGNER_SECRET_ARN) {
        return undefined;
      }

      const response = await secretsManagerClient.send(
        new GetSecretValueCommand({ SecretId: FAUCET_SIGNER_SECRET_ARN })
      );

      const secretString = response.SecretString;
      if (!secretString) {
        throw new Error("faucet_signer_secret_invalid: SecretString is empty");
      }

      const secretPrivateKey = parsePrivateKeyFromSecret(secretString);
      if (!secretPrivateKey) {
        throw new Error("faucet_signer_secret_invalid: expected a 32-byte hex private key");
      }

      cachedFaucetSignerAccount = privateKeyToAccount(secretPrivateKey);
      return cachedFaucetSignerAccount;
    })();
  }

  return faucetSignerLoadPromise;
}

const kmsSigner =
  KMS_KEY_ID && PAYMASTER_SIGNER_ADDRESS
    ? new KmsSignerService({
      kmsKeyId: KMS_KEY_ID,
      signerAddress: PAYMASTER_SIGNER_ADDRESS,
      region: process.env.AWS_REGION,
    })
    : undefined;

const persistence = new PersistenceService();

type ChainKey = "base_sepolia" | "etherlink_shadownet";
type ChainConfig = {
  key: ChainKey;
  name: string;
  chainId: number;
  rpcUrl?: string;
  stableSwapAddress?: Address;
  idrxTokenAddress?: Address;
  entryPointAddress?: Address;
};

const CHAINS: Record<ChainKey, ChainConfig> = {
  base_sepolia: {
    key: "base_sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: RPC_URL,
    stableSwapAddress: STABLE_SWAP_ADDRESS,
    idrxTokenAddress: IDRX_TOKEN_ADDRESS,
    entryPointAddress: ENTRY_POINT_ADDRESS,
  },
  etherlink_shadownet: {
    key: "etherlink_shadownet",
    name: "Etherlink Shadownet",
    chainId: 127823,
    rpcUrl: RPC_URL_ETHERLINK,
    stableSwapAddress: STABLE_SWAP_ADDRESS_ETHERLINK,
    idrxTokenAddress: IDRX_TOKEN_ADDRESS_ETHERLINK,
    entryPointAddress: ENTRY_POINT_ADDRESS_ETHERLINK,
  },
};

function parseChainKey(input: unknown): ChainKey | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }
  const raw = String(input).trim().toLowerCase();
  if (raw === "base" || raw === "base_sepolia" || raw === "84532") return "base_sepolia";
  if (raw === "etherlink" || raw === "etherlink_shadownet" || raw === "shadownet" || raw === "127823") {
    return "etherlink_shadownet";
  }
  throw new Error("Unsupported chain. Use base|84532 or etherlink|127823.");
}

const DEFAULT_CHAIN: ChainKey = (() => {
  if (!process.env.DEFAULT_CHAIN) return "etherlink_shadownet";
  try {
    return parseChainKey(process.env.DEFAULT_CHAIN) ?? "etherlink_shadownet";
  } catch (error) {
    console.warn(
      `WARN: DEFAULT_CHAIN is invalid ("${process.env.DEFAULT_CHAIN}"). Falling back to etherlink_shadownet.`
    );
    return "etherlink_shadownet";
  }
})();

const publicClients: Partial<Record<ChainKey, ReturnType<typeof createPublicClient>>> = {};
for (const chain of Object.values(CHAINS)) {
  if (chain.rpcUrl) {
    publicClients[chain.key] = createPublicClient({
      transport: http(chain.rpcUrl),
    });
  }
}

const STABLE_SWAP_ABI = [
  {
    type: "function",
    name: "getSwapQuote",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address", internalType: "address" },
      { name: "tokenOut", type: "address", internalType: "address" },
      { name: "amountIn", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256", internalType: "uint256" },
      { name: "fee", type: "uint256", internalType: "uint256" },
      { name: "totalUserPays", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "function",
    name: "reserves",
    stateMutability: "view",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256", internalType: "uint256" },
      { name: "tokenIn", type: "address", internalType: "address" },
      { name: "tokenOut", type: "address", internalType: "address" },
      { name: "minAmountOut", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256", internalType: "uint256" }],
  },
] as const;

type DeterministicSwapQuote = {
  amountOut: bigint;
  fee: bigint;
  totalUserPays: bigint;
  outputReserve: bigint;
};

/**
 * MockStableCoin ABI - Used for minting IDRX tokens on testnet
 * The mint function allows minting tokens to any address
 */
const MOCK_STABLECOIN_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * EntryPoint ABI - Used for checking wallet initialization via nonce
 * The getNonce function returns the nonce for a wallet address
 */
const ENTRY_POINT_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

console.log("");
console.log("=====================================================");
console.log("   PAYMASTER SIGNER BACKEND");
console.log("=====================================================");
console.log("");
console.log(`   Signer Address: ${PAYMASTER_SIGNER_ADDRESS ?? "(kms signer address not configured)"}`);
console.log("   Make sure this address is added as authorized signer on Paymaster.");
console.log(`   Base StableSwap: ${STABLE_SWAP_ADDRESS}`);
if (STABLE_SWAP_ADDRESS_ETHERLINK) {
  console.log(`   Etherlink StableSwap: ${STABLE_SWAP_ADDRESS_ETHERLINK}`);
}
console.log("");

function requireAddress(addr: unknown, field: string): Address {
  if (typeof addr !== "string") {
    throw new Error(`${field} is required`);
  }
  return getAddress(addr) as Address;
}

function requireAmount(value: unknown, field: string): bigint {
  if (value === undefined || value === null) {
    throw new Error(`${field} is required`);
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    typeof value !== "boolean"
  ) {
    throw new Error(`${field} must be a positive integer string/number`);
  }
  try {
    const bi = BigInt(value);
    if (bi <= 0n) throw new Error();
    return bi;
  } catch {
    throw new Error(`${field} must be a positive integer string/number`);
  }
}

function normalizeTimestamp(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function resolveChainKey(input: unknown): ChainKey {
  const parsed = parseChainKey(input);
  return parsed ?? DEFAULT_CHAIN;
}

function getChainContext(req: express.Request): {
  chain: ChainConfig;
  publicClient: ReturnType<typeof createPublicClient>;
  stableSwapAddress: Address;
} {
  const chainKey = resolveChainKey(
    req.query.chain ??
    req.query.chainId ??
    req.body?.chain ??
    req.body?.chainId ??
    req.headers["x-chain"]
  );
  const chain = CHAINS[chainKey];
  if (!chain.rpcUrl || !chain.stableSwapAddress) {
    throw new Error(`Chain not configured: ${chainKey}`);
  }
  const publicClient = publicClients[chainKey];
  if (!publicClient) {
    throw new Error(`Public client not initialized for: ${chainKey}`);
  }
  return { chain, publicClient, stableSwapAddress: chain.stableSwapAddress };
}

function getChainContextByKey(chainKey: ChainKey): {
  chain: ChainConfig;
  publicClient: ReturnType<typeof createPublicClient>;
  stableSwapAddress: Address;
} {
  const chain = CHAINS[chainKey];
  if (!chain.rpcUrl || !chain.stableSwapAddress) {
    throw new Error(`Chain not configured: ${chainKey}`);
  }
  const publicClient = publicClients[chainKey];
  if (!publicClient) {
    throw new Error(`Public client not initialized for: ${chainKey}`);
  }
  return { chain, publicClient, stableSwapAddress: chain.stableSwapAddress };
}

function computePaymasterDigest(params: {
  payerAddress: Address;
  tokenAddress: Address;
  validUntil: number;
  validAfter: number;
  isActivation: boolean;
}): Hex {
  const rawDigest = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint256, uint256, bool"), [
      getAddress(params.payerAddress),
      getAddress(params.tokenAddress),
      BigInt(params.validUntil),
      BigInt(params.validAfter),
      params.isActivation,
    ])
  );

  return keccak256(
    encodePacked(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", rawDigest])
  );
}

async function replayedSignatureMatchesConfiguredSigner(params: {
  signature: Hex;
  payerAddress: Address;
  tokenAddress: Address;
  validUntil: number;
  validAfter: number;
  isActivation: boolean;
  expectedSignerAddress?: Address;
}): Promise<boolean> {
  if (!params.expectedSignerAddress) {
    return false;
  }

  try {
    const digest = computePaymasterDigest({
      payerAddress: params.payerAddress,
      tokenAddress: params.tokenAddress,
      validUntil: params.validUntil,
      validAfter: params.validAfter,
      isActivation: params.isActivation,
    });

    const recovered = await recoverAddress({
      hash: digest,
      signature: params.signature,
    });

    return recovered.toLowerCase() === params.expectedSignerAddress.toLowerCase();
  } catch {
    return false;
  }
}

async function getSwapQuoteForChain(
  chainKey: ChainKey,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<{ amountOut: string; fee: string; totalUserPays: string } | undefined> {
  try {
    const { publicClient, stableSwapAddress } = getChainContextByKey(chainKey);
    const quote = await readDeterministicSwapQuote(
      publicClient,
      stableSwapAddress,
      tokenIn,
      tokenOut,
      amountIn
    );
    if (quote.outputReserve < quote.amountOut) {
      return undefined;
    }

    return {
      amountOut: quote.amountOut.toString(),
      fee: quote.fee.toString(),
      totalUserPays: quote.totalUserPays.toString(),
    };
  } catch {
    return undefined;
  }
}

async function readDeterministicSwapQuote(
  publicClient: ReturnType<typeof createPublicClient>,
  stableSwapAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<DeterministicSwapQuote> {
  const [amountOut, fee, totalUserPays] = (await publicClient.readContract({
    address: stableSwapAddress,
    abi: STABLE_SWAP_ABI,
    functionName: "getSwapQuote",
    args: [tokenIn, tokenOut, amountIn],
  })) as readonly [bigint, bigint, bigint];

  const outputReserve = (await publicClient.readContract({
    address: stableSwapAddress,
    abi: STABLE_SWAP_ABI,
    functionName: "reserves",
    args: [tokenOut],
  })) as bigint;

  return {
    amountOut,
    fee,
    totalUserPays,
    outputReserve,
  };
}

function assertSufficientOutputLiquidity(params: {
  amountOut: bigint;
  outputReserve: bigint;
  tokenOut: Address;
}): void {
  if (params.outputReserve < params.amountOut) {
    throw new Error(
      `Insufficient pool liquidity for output token ${params.tokenOut}. Try a smaller amount or different pair.`
    );
  }
}

/**
 * Check if a wallet is already initialized on-chain
 * 
 * This function checks if a smart wallet has been deployed and initialized by:
 * 1. Checking if bytecode exists at the wallet address (deployed contract)
 * 2. Checking if the EntryPoint nonce is greater than 0 (has sent UserOperations)
 * 
 * @param walletAddress - The smart wallet address to check
 * @param publicClient - The viem public client for the chain
 * @param entryPointAddress - The EntryPoint contract address (optional)
 * @returns true if wallet is initialized, false otherwise
 */
async function checkOnChainActivation(
  walletAddress: Address,
  publicClient: ReturnType<typeof createPublicClient>,
  entryPointAddress?: Address
): Promise<boolean> {
  try {
    // Method 1: Check if bytecode exists at the wallet address
    const bytecode = await publicClient.getBytecode({ address: walletAddress });
    if (bytecode && bytecode !== "0x" && bytecode.length > 2) {
      console.log(`   Wallet ${walletAddress} has bytecode deployed (initialized)`);
      return true;
    }

    // Method 2: Check EntryPoint nonce if EntryPoint address is available
    if (entryPointAddress) {
      const nonce = await publicClient.readContract({
        address: entryPointAddress,
        abi: ENTRY_POINT_ABI,
        functionName: "getNonce",
        args: [walletAddress, 0n],
      }) as bigint;

      if (nonce > 0n) {
        console.log(`   Wallet ${walletAddress} has nonce ${nonce} (initialized)`);
        return true;
      }
    }

    console.log(`   Wallet ${walletAddress} is not initialized`);
    return false;
  } catch (error) {
    console.error(`   Error checking on-chain activation for ${walletAddress}:`, error);
    // On error, return false to allow the request to proceed (fail open)
    return false;
  }
}

// =====================================================
// ROUTES
// =====================================================

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    signerAddress: PAYMASTER_SIGNER_ADDRESS ?? null,
    message: "Backend ready.",
    signerSource: kmsSigner ? "kms" : "not_configured",
    persistenceEnabled: persistence.isEnabled(),
    defaultChain: DEFAULT_CHAIN,
    chains: Object.values(CHAINS).map((chain) => ({
      key: chain.key,
      name: chain.name,
      chainId: chain.chainId,
      enabled: Boolean(chain.rpcUrl && chain.stableSwapAddress),
      stableSwapAddress: chain.stableSwapAddress || null,
    })),
  });
});

app.get("/signer", (_, res) => {
  if (!PAYMASTER_SIGNER_ADDRESS) {
    return res.status(500).json({
      error: "signer_not_configured",
      message: "PAYMASTER_SIGNER_ADDRESS is not configured",
    });
  }

  res.json({
    signerAddress: PAYMASTER_SIGNER_ADDRESS,
    note: "Add this address as authorized signer on Paymaster",
  });
});

/**
 * POST /sign - Sign paymaster data
 *
 * Body: {
 *   payerAddress: "0x..." (EOA payer),
 *   tokenAddress: "0x...",
 *   validUntil: 1704067200,
 *   validAfter: 0,
 *   isActivation: false,
 *   chain?: "base" | "etherlink" (optional)
 * }
 */
app.post("/sign", requireSignApiKey, signRateLimiter, async (req, res) => {
  const requestContext = createRequestContext(req, res);

  try {
    if (!kmsSigner) {
      return res.status(500).json({
        error: "kms_not_configured",
        message: "KMS_KEY_ID and PAYMASTER_SIGNER_ADDRESS must be configured",
      });
    }

    const { payerAddress, tokenAddress, validUntil, validAfter, isActivation } = req.body;

    if (!payerAddress || !tokenAddress) {
      return res.status(400).json({
        error: "Missing required fields: payerAddress, tokenAddress",
      });
    }

    console.log("Signing request:");
    console.log(`   payer: ${payerAddress}`);
    console.log(`   token: ${tokenAddress}`);
    console.log(`   isActivation: ${isActivation}`);

    // Guard: Check on-chain activation status for activation requests
    if (isActivation === true) {
      try {
        const { chain, publicClient } = getChainContext(req);
        const isInitialized = await checkOnChainActivation(
          payerAddress as Address,
          publicClient,
          chain.entryPointAddress
        );

        if (isInitialized) {
          console.log(`   REJECTED: Wallet ${payerAddress} is already activated on-chain`);
          return res.status(400).json({
            error: "ALREADY_ACTIVATED",
            message: "Wallet is already activated on-chain",
          });
        }
      } catch (error) {
        console.error("   Error during on-chain activation check:", error);
        // Continue with signing if check fails (fail open to avoid blocking legitimate requests)
      }
    }

    const chainContext = getChainContext(req);
    const normalizedPayerAddress = requireAddress(payerAddress, "payerAddress");
    const normalizedTokenAddress = requireAddress(tokenAddress, "tokenAddress");
    const resolvedValidUntil = normalizeTimestamp(
      validUntil,
      Math.floor(Date.now() / 1000) + 3600,
      "validUntil"
    );
    const resolvedValidAfter = normalizeTimestamp(validAfter, 0, "validAfter");
    assertSignValidityWindow(resolvedValidAfter, resolvedValidUntil);

    const resolvedIsActivation = Boolean(isActivation);
    const idempotencyKeyHeader = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof idempotencyKeyHeader === "string" && idempotencyKeyHeader.trim() !== ""
        ? idempotencyKeyHeader.trim()
        : undefined;

    const operationHash = persistence.buildOperationHash({
      payerAddress: normalizedPayerAddress,
      tokenAddress: normalizedTokenAddress,
      validUntil: resolvedValidUntil,
      validAfter: resolvedValidAfter,
      isActivation: resolvedIsActivation,
      chain: chainContext.chain.key,
    });

    const existingOperation = await persistence.getUserOperation(operationHash);
    if (existingOperation?.signature) {
      const replaySignatureValid = await replayedSignatureMatchesConfiguredSigner({
        signature: existingOperation.signature as Hex,
        payerAddress: normalizedPayerAddress,
        tokenAddress: normalizedTokenAddress,
        validUntil: resolvedValidUntil,
        validAfter: resolvedValidAfter,
        isActivation: resolvedIsActivation,
        expectedSignerAddress: PAYMASTER_SIGNER_ADDRESS,
      });

      if (!replaySignatureValid) {
        logger.warn({
          requestId: requestContext.requestId,
          endpoint: "/sign",
          method: "POST",
          chainId: chainContext.chain.chainId,
          latencyMs: getLatencyMs(requestContext),
          result: "failure",
          message: "Ignoring stale persisted signature that does not match configured signer",
        });
      } else {
        emitCountMetric("PaymasterSignSuccess", 1, {
          endpoint: "/sign",
          chainId: String(chainContext.chain.chainId),
        });

        logger.info({
          requestId: requestContext.requestId,
          endpoint: "/sign",
          method: "POST",
          chainId: chainContext.chain.chainId,
          latencyMs: getLatencyMs(requestContext),
          result: "success",
          message: "Replayed persisted signature",
        });

        return res.json({
          signature: existingOperation.signature,
          operationHash,
          replayed: true,
        });
      }
    }

    const signature = await kmsSigner.signPaymasterData({
      payerAddress: normalizedPayerAddress,
      tokenAddress: normalizedTokenAddress,
      validUntil: resolvedValidUntil,
      validAfter: resolvedValidAfter,
      isActivation: resolvedIsActivation,
    });

    try {
      await persistence.putUserOperation({
        operationHash,
        signature,
        payerAddress: normalizedPayerAddress,
        tokenAddress: normalizedTokenAddress,
        validUntil: resolvedValidUntil,
        validAfter: resolvedValidAfter,
        isActivation: resolvedIsActivation,
        chain: chainContext.chain.key,
        idempotencyKey,
      });
    } catch (persistError) {
      console.error("Failed to persist user operation:", persistError);
    }

    console.log("   Signed!");

    logger.info({
      requestId: requestContext.requestId,
      endpoint: "/sign",
      method: "POST",
      chainId: chainContext.chain.chainId,
      latencyMs: getLatencyMs(requestContext),
      result: "success",
      message: "Generated paymaster signature",
    });

    emitCountMetric("PaymasterSignSuccess", 1, {
      endpoint: "/sign",
      chainId: String(chainContext.chain.chainId),
    });

    res.json({ signature, operationHash });
  } catch (error) {
    if (isValidationError(error)) {
      emitCountMetric("PaymasterSignFailure", 1, { endpoint: "/sign" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/sign",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: error.code,
        message: error.message,
      });

      return res.status(400).json({
        error: error.code,
        message: error.message,
      });
    }

    logger.error({
      requestId: requestContext.requestId,
      endpoint: "/sign",
      method: "POST",
      latencyMs: getLatencyMs(requestContext),
      result: "failure",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown error",
    });

    emitCountMetric("PaymasterSignFailure", 1, { endpoint: "/sign" });

    console.error("Signing error:", error);
    res.status(500).json({
      error: "Signing failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /swap/quote
 * Query: tokenIn, tokenOut, amountIn (uint256 in tokenIn decimals)
 */
app.get("/swap/quote", async (req, res) => {
  const requestContext = createRequestContext(req, res);

  try {
    const tokenIn = requireAddress(req.query.tokenIn, "tokenIn");
    const tokenOut = requireAddress(req.query.tokenOut, "tokenOut");
    const amountIn = requireAmount(req.query.amountIn, "amountIn");
    const { chain, publicClient, stableSwapAddress } = getChainContext(req);

    const quote = await readDeterministicSwapQuote(
      publicClient,
      stableSwapAddress,
      tokenIn,
      tokenOut,
      amountIn
    );
    assertSufficientOutputLiquidity({
      amountOut: quote.amountOut,
      outputReserve: quote.outputReserve,
      tokenOut,
    });

    const availableChainKeys = (Object.values(CHAINS)
      .filter((item) => item.rpcUrl && item.stableSwapAddress)
      .map((item) => item.key)) as ChainKey[];

    const quotePairs = await Promise.all(
      availableChainKeys.map(async (chainKey) => [
        chainKey,
        await getSwapQuoteForChain(chainKey, tokenIn, tokenOut, amountIn),
      ] as const)
    );

    const quotesByChain = Object.fromEntries(
      quotePairs.filter((pair) => pair[1] !== undefined)
    ) as Partial<Record<ChainKey, { amountOut: string; fee: string; totalUserPays: string }>>;

    const aiAdvisory = await getRoutingAdvisory({
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      selectedChain: chain.key,
      availableChains: availableChainKeys,
      quotesByChain,
    });

    logger.info({
      requestId: requestContext.requestId,
      endpoint: "/swap/quote",
      method: "GET",
      chainId: chain.chainId,
      latencyMs: getLatencyMs(requestContext),
      result: "success",
      message: "Fetched swap quote",
    });

    emitCountMetric("SwapQuoteSuccess", 1, {
      endpoint: "/swap/quote",
      chainId: String(chain.chainId),
    });

    if (aiAdvisory.enabled && aiAdvisory.guardrailsPassed) {
      emitCountMetric("AiRouterRecommendationAccepted", 1, {
        endpoint: "/swap/quote",
      });
    } else {
      emitCountMetric("AiRouterFallbackUsed", 1, {
        endpoint: "/swap/quote",
      });
    }

    res.json({
      chain: chain.key,
      chainId: chain.chainId,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      fee: quote.fee.toString(),
      totalUserPays: quote.totalUserPays.toString(),
      aiAdvisory,
    });
  } catch (error) {
    emitCountMetric("SwapQuoteFailure", 1, { endpoint: "/swap/quote" });

    logger.warn({
      requestId: requestContext.requestId,
      endpoint: "/swap/quote",
      method: "GET",
      latencyMs: getLatencyMs(requestContext),
      result: "failure",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown error",
    });

    console.error("Quote error:", error);
    res.status(400).json({
      error: "quote_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /swap/build
 * Body: { tokenIn, tokenOut, amountIn, minAmountOut }
 * Returns calldata for StableSwap.swap
 */
app.post("/swap/build", async (req, res) => {
  const requestContext = createRequestContext(req, res);

  try {
    const tokenIn = requireAddress(req.body?.tokenIn, "tokenIn");
    const tokenOut = requireAddress(req.body?.tokenOut, "tokenOut");
    const amountIn = requireAmount(req.body?.amountIn, "amountIn");
    const minAmountOut = requireAmount(req.body?.minAmountOut, "minAmountOut");
    const autoRoute = req.body?.autoRoute === true;
    const requestedContext = getChainContext(req);

    let aiAdvisory: RoutingAdvisory = {
      enabled: false,
      source: "deterministic" as const,
      selectedChain: requestedContext.chain.key,
      confidence: 1,
      reason: "Auto-route disabled",
      guardrailsPassed: false,
      rejectedReason: "auto_route_disabled",
      estimatedFeeBps: undefined as number | undefined,
    };

    let effectiveContext = requestedContext;

    if (autoRoute) {
      const availableChainKeys = (Object.values(CHAINS)
        .filter((item) => item.rpcUrl && item.stableSwapAddress)
        .map((item) => item.key)) as ChainKey[];

      const quotePairs = await Promise.all(
        availableChainKeys.map(async (chainKey) => [
          chainKey,
          await getSwapQuoteForChain(chainKey, tokenIn, tokenOut, amountIn),
        ] as const)
      );

      const quotesByChain = Object.fromEntries(
        quotePairs.filter((pair) => pair[1] !== undefined)
      ) as Partial<Record<ChainKey, { amountOut: string; fee: string; totalUserPays: string }>>;

      aiAdvisory = await getRoutingAdvisory({
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        selectedChain: requestedContext.chain.key,
        availableChains: availableChainKeys,
        quotesByChain,
      });

      const effectiveChainKey =
        aiAdvisory.guardrailsPassed
          ? aiAdvisory.selectedChain
          : requestedContext.chain.key;

      effectiveContext = getChainContextByKey(effectiveChainKey);

      const selectedQuote = quotesByChain[effectiveChainKey];
      if (!selectedQuote) {
        throw new Error(`No deterministic quote available for chain ${effectiveChainKey}`);
      }

      if (BigInt(selectedQuote.amountOut) < minAmountOut) {
        throw new Error("minAmountOut exceeds deterministic on-chain quote");
      }
    }

    const effectiveQuote = await readDeterministicSwapQuote(
      effectiveContext.publicClient,
      effectiveContext.stableSwapAddress,
      tokenIn,
      tokenOut,
      amountIn
    );
    assertSufficientOutputLiquidity({
      amountOut: effectiveQuote.amountOut,
      outputReserve: effectiveQuote.outputReserve,
      tokenOut,
    });

    const data = encodeFunctionData({
      abi: STABLE_SWAP_ABI,
      functionName: "swap",
      args: [amountIn, tokenIn, tokenOut, minAmountOut],
    });

    try {
      const idempotencyKeyHeader = req.headers["idempotency-key"];
      const idempotencyKey =
        typeof idempotencyKeyHeader === "string" && idempotencyKeyHeader.trim() !== ""
          ? idempotencyKeyHeader.trim()
          : undefined;

      await persistence.recordSwapBuild(
        {
          chain: effectiveContext.chain.key,
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          minAmountOut: minAmountOut.toString(),
          to: effectiveContext.stableSwapAddress,
        },
        idempotencyKey
      );
    } catch (persistError) {
      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/swap/build",
        method: "POST",
        chainId: effectiveContext.chain.chainId,
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: persistError instanceof Error ? persistError.name : "UnknownError",
        message: "Failed to persist swap build metadata",
      });

      console.error("Failed to persist swap build:", persistError);
    }

    logger.info({
      requestId: requestContext.requestId,
      endpoint: "/swap/build",
      method: "POST",
      chainId: effectiveContext.chain.chainId,
      latencyMs: getLatencyMs(requestContext),
      result: "success",
      message: "Built swap calldata",
    });

    emitCountMetric("SwapBuildSuccess", 1, {
      endpoint: "/swap/build",
      chainId: String(effectiveContext.chain.chainId),
    });

    if (aiAdvisory.enabled && aiAdvisory.guardrailsPassed && autoRoute) {
      emitCountMetric("AiRouterRecommendationAccepted", 1, {
        endpoint: "/swap/build",
      });
    } else if (aiAdvisory.enabled) {
      emitCountMetric("AiRouterFallbackUsed", 1, {
        endpoint: "/swap/build",
      });
    }

    await publishSwapCompleted({
      requestId: requestContext.requestId,
      chain: effectiveContext.chain.key,
      chainId: effectiveContext.chain.chainId,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      to: effectiveContext.stableSwapAddress,
    });

    res.json({
      chain: effectiveContext.chain.key,
      chainId: effectiveContext.chain.chainId,
      to: effectiveContext.stableSwapAddress,
      data,
      value: "0",
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      autoRouteApplied: autoRoute && aiAdvisory.guardrailsPassed,
      aiAdvisory,
      note: "Use this calldata in your smart account / wallet tx",
    });
  } catch (error) {
    emitCountMetric("SwapBuildFailure", 1, { endpoint: "/swap/build" });

    logger.warn({
      requestId: requestContext.requestId,
      endpoint: "/swap/build",
      method: "POST",
      latencyMs: getLatencyMs(requestContext),
      result: "failure",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown error",
    });

    console.error("Build swap error:", error);
    await publishTransactionFailed({
      requestId: requestContext.requestId,
      endpoint: "/swap/build",
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(400).json({
      error: "build_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /topup-idrx
 * Body: { walletAddress, amount, chain? }
 * Mints IDRX tokens to the specified wallet address
 */
app.post("/topup-idrx", requireTopupApiKey, topupRateLimiter, async (req, res) => {
  const requestContext = createRequestContext(req, res);

  try {
    const { walletAddress, amount } = req.body;
    const idempotencyKeyHeader = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof idempotencyKeyHeader === "string" && idempotencyKeyHeader.trim() !== ""
        ? idempotencyKeyHeader.trim()
        : undefined;

    // Validate walletAddress is provided and is a valid Ethereum address
    if (!walletAddress || typeof walletAddress !== "string") {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "invalid_address",
        message: "walletAddress is required and must be a string",
      });

      return res.status(400).json({
        error: "invalid_address",
        message: "walletAddress is required and must be a string",
      });
    }

    // Validate and normalize wallet address (checksum-safe for downstream viem calls)
    let normalizedWalletAddress: Address;
    try {
      normalizedWalletAddress = getAddress(walletAddress as Address);
    } catch {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "invalid_address",
        message: "walletAddress must be a valid Ethereum address",
      });

      return res.status(400).json({
        error: "invalid_address",
        message: "walletAddress must be a valid Ethereum address",
      });
    }

    // Validate amount is provided
    if (amount === undefined || amount === null || amount === "") {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "invalid_amount",
        message: "amount is required",
      });

      return res.status(400).json({
        error: "invalid_amount",
        message: "amount is required",
      });
    }

    // Validate amount is a positive number
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "invalid_amount",
        message: "amount must be a positive number",
      });

      return res.status(400).json({
        error: "invalid_amount",
        message: "amount must be a positive number",
      });
    }

    // Parse amount to wei units (6 decimals for IDRX)
    // IDRX uses 6 decimal places, so multiply by 10^6 to convert to smallest unit
    // Example: 100.50 IDRX → 100,500,000 wei
    const amountInWei = Math.floor(amountNum * 1_000_000);

    // Validate amount does not exceed maximum safe integer
    if (amountInWei > Number.MAX_SAFE_INTEGER) {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "amount_out_of_range",
        message: "amount exceeds maximum safe integer value",
      });

      return res.status(400).json({
        error: "amount_out_of_range",
        message: "amount exceeds maximum safe integer value",
      });
    }

    // Resolve chain context using existing helper
    // This determines which blockchain network to use (Base Sepolia or Etherlink)
    // based on the chain parameter in the request body, query string, or header
    let chainContext;
    try {
      chainContext = getChainContext(req);
    } catch (error) {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "chain_not_configured",
        message: error instanceof Error ? error.message : "Chain not configured",
      });

      return res.status(400).json({
        error: "chain_not_configured",
        message: error instanceof Error ? error.message : "Chain not configured",
      });
    }

    const { chain, publicClient } = chainContext;

    if (!idempotencyKey) {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        chainId: chain.chainId,
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "invalid_idempotency_key",
        message: "Idempotency-Key header is required",
      });

      return res.status(400).json({
        error: "invalid_idempotency_key",
        message: "Idempotency-Key header is required",
      });
    }

    const topupOperationHash = persistence.buildTopupOperationHash({
      walletAddress: normalizedWalletAddress,
      chain: chain.key,
      idempotencyKey,
    });

    const existingTopupRecord = await persistence.getTopupIdempotencyRecord(topupOperationHash);
    if (existingTopupRecord?.status === "IN_PROGRESS") {
      emitCountMetric("TopupFailure", 1, {
        endpoint: "/topup-idrx",
        chainId: String(chain.chainId),
      });

      return res.status(409).json({
        error: "idempotency_in_progress",
        message: "A top-up request with this key is still processing",
      });
    }

    if (existingTopupRecord?.status === "SUCCEEDED" && existingTopupRecord.responsePayload) {
      logger.info({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        chainId: chain.chainId,
        latencyMs: getLatencyMs(requestContext),
        result: "success",
        message: "Replayed successful top-up response",
      });

      return res.status(existingTopupRecord.httpStatusCode ?? 200).json({
        ...existingTopupRecord.responsePayload,
        replayed: true,
      });
    }

    if (existingTopupRecord?.status === "FAILED") {
      return res.status(existingTopupRecord.httpStatusCode ?? 500).json({
        ...(existingTopupRecord.errorPayload ?? {
          error: "topup_failed",
          message: "Previous top-up request failed",
        }),
        replayed: true,
      });
    }

    const inProgressResult = await persistence.putTopupInProgress({
      operationHash: topupOperationHash,
      walletAddress: normalizedWalletAddress,
      chain: chain.key,
      idempotencyKey,
    });

    if (inProgressResult === "already_exists") {
      return res.status(409).json({
        error: "idempotency_in_progress",
        message: "A top-up request with this key is still processing",
      });
    }

    const faucetSignerAccount = await getFaucetSignerAccount();
    if (!faucetSignerAccount) {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.error({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "faucet_signer_not_configured",
        message: "Faucet signer is not configured",
      });

      const errorPayload = {
        error: "faucet_signer_not_configured",
        message: "Faucet signer is not configured",
      };

      await persistence.finalizeTopupIdempotency({
        operationHash: topupOperationHash,
        status: "FAILED",
        httpStatusCode: 500,
        errorPayload,
      });

      await publishTransactionFailed({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        chain: chain.key,
        chainId: chain.chainId,
        walletAddress: normalizedWalletAddress,
        error: errorPayload.message,
      });

      return res.status(500).json(errorPayload);
    }

    // Validate IDRX token address is configured for this chain
    if (!chain.idrxTokenAddress) {
      emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

      logger.warn({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        chainId: chain.chainId,
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: "chain_not_configured",
        message: `IDRX token address not configured for chain: ${chain.key}`,
      });

      const errorPayload = {
        error: "chain_not_configured",
        message: `IDRX token address not configured for chain: ${chain.key}`,
      };

      await persistence.finalizeTopupIdempotency({
        operationHash: topupOperationHash,
        status: "FAILED",
        httpStatusCode: 400,
        errorPayload,
      });

      await publishTransactionFailed({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        chain: chain.key,
        chainId: chain.chainId,
        walletAddress: normalizedWalletAddress,
        error: errorPayload.message,
      });

      return res.status(400).json({
        ...errorPayload,
      });
    }

    console.log("Top-up IDRX request:");
    console.log(`   Chain: ${chain.name} (${chain.chainId})`);
    console.log(`   Wallet: ${normalizedWalletAddress}`);
    console.log(`   Amount: ${amountNum} IDRX (${amountInWei} wei)`);
    console.log(`   IDRX Token: ${chain.idrxTokenAddress}`);

    // Call mint function on IDRX token contract
    try {
      const { createWalletClient } = await import("viem");
      const { http: httpTransport } = await import("viem");

      // Create wallet client for sending transactions
      const walletClient = createWalletClient({
        account: faucetSignerAccount,
        chain: {
          id: chain.chainId,
          name: chain.name,
          network: chain.key,
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: {
            default: { http: [chain.rpcUrl!] },
            public: { http: [chain.rpcUrl!] },
          },
        },
        transport: httpTransport(chain.rpcUrl),
      });

      // Encode mint function call with recipient address and amount in wei
      // The mint function signature is: mint(address to, uint256 amount)
      // This encodes the function call into transaction data
      const mintData = encodeFunctionData({
        abi: MOCK_STABLECOIN_ABI,
        functionName: "mint",
        args: [normalizedWalletAddress, BigInt(amountInWei)],
      });

      console.log("   Sending mint transaction...");

      // Send transaction
      const txHash = await walletClient.sendTransaction({
        to: chain.idrxTokenAddress,
        data: mintData,
      });

      console.log(`   Transaction sent: ${txHash}`);

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      console.log(`   Transaction confirmed in block ${receipt.blockNumber}`);

      // Return success response with transaction hash
      try {
        await persistence.recordWalletActivation(normalizedWalletAddress, {
          chain: chain.key,
          transactionHash: txHash,
          amount: amountNum.toString(),
        });
      } catch (persistError) {
        console.error("Failed to persist wallet activation:", persistError);
      }

      const successPayload = {
        success: true,
        transactionHash: txHash,
        amount: amountNum.toString(),
        recipient: normalizedWalletAddress,
        chain: chain.key,
        chainId: chain.chainId,
      };

      await persistence.finalizeTopupIdempotency({
        operationHash: topupOperationHash,
        status: "SUCCEEDED",
        httpStatusCode: 200,
        responsePayload: successPayload,
      });

      await publishWalletActivated({
        requestId: requestContext.requestId,
        chain: chain.key,
        chainId: chain.chainId,
        walletAddress: normalizedWalletAddress,
        amount: amountNum.toString(),
        transactionHash: txHash,
      });

      res.json(successPayload);

      logger.info({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        chainId: chain.chainId,
        latencyMs: getLatencyMs(requestContext),
        result: "success",
        message: "Minted top-up transaction",
      });

      emitCountMetric("TopupSuccess", 1, {
        endpoint: "/topup-idrx",
        chainId: String(chain.chainId),
      });
    } catch (mintError) {
      emitCountMetric("TopupFailure", 1, {
        endpoint: "/topup-idrx",
        chainId: String(chain.chainId),
      });

      logger.error({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        method: "POST",
        chainId: chain.chainId,
        latencyMs: getLatencyMs(requestContext),
        result: "failure",
        errorClass: mintError instanceof Error ? mintError.name : "UnknownError",
        message: mintError instanceof Error ? mintError.message : "Failed to mint tokens",
      });

      console.error("   Mint transaction failed:", mintError);
      const errorPayload = {
        error: "mint_failed",
        message: mintError instanceof Error ? mintError.message : "Failed to mint tokens",
      };

      await persistence.finalizeTopupIdempotency({
        operationHash: topupOperationHash,
        status: "FAILED",
        httpStatusCode: 500,
        errorPayload,
      });

      await publishTransactionFailed({
        requestId: requestContext.requestId,
        endpoint: "/topup-idrx",
        chain: chain.key,
        chainId: chain.chainId,
        walletAddress: normalizedWalletAddress,
        error: errorPayload.message,
      });

      return res.status(500).json(errorPayload);
    }
  } catch (error) {
    emitCountMetric("TopupFailure", 1, { endpoint: "/topup-idrx" });

    logger.error({
      requestId: requestContext.requestId,
      endpoint: "/topup-idrx",
      method: "POST",
      latencyMs: getLatencyMs(requestContext),
      result: "failure",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown error",
    });

    console.error("Top-up error:", error);
    await publishTransactionFailed({
      requestId: requestContext.requestId,
      endpoint: "/topup-idrx",
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(500).json({
      error: "topup_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof Error && error.message === "cors_origin_not_allowed") {
    return res.status(403).json({
      error: "cors_origin_not_allowed",
      message: "Request origin is not allowed",
    });
  }

  return next(error);
});

export { app };
