import express from "express";
import cors from "cors";
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  createPublicClient,
  encodeFunctionData,
  http,
  getAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGINS?.split(",") || "*",
  })
);

// =====================================================
// Validate private key
// =====================================================
const PRIVATE_KEY = process.env.PAYMASTER_SIGNER_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const RPC_URL_ETHERLINK = process.env.RPC_URL_ETHERLINK;
const STABLE_SWAP_ADDRESS = process.env.STABLE_SWAP_ADDRESS as Address | undefined;
const STABLE_SWAP_ADDRESS_ETHERLINK = process.env.STABLE_SWAP_ADDRESS_ETHERLINK as Address | undefined;
const IDRX_TOKEN_ADDRESS = process.env.IDRX_TOKEN_ADDRESS as Address | undefined;
const IDRX_TOKEN_ADDRESS_ETHERLINK = process.env.IDRX_TOKEN_ADDRESS_ETHERLINK as Address | undefined;

if (!PRIVATE_KEY) {
  console.error("ERROR: PAYMASTER_SIGNER_PRIVATE_KEY not found in .env");
  process.exit(1);
}

if (!RPC_URL) {
  console.error("ERROR: RPC_URL not found in .env (needed for swap quote)");
  process.exit(1);
}

if (!STABLE_SWAP_ADDRESS) {
  console.error("ERROR: STABLE_SWAP_ADDRESS not found in .env");
  process.exit(1);
}

if (!RPC_URL_ETHERLINK || !STABLE_SWAP_ADDRESS_ETHERLINK) {
  console.warn("WARN: Etherlink is not configured (RPC_URL_ETHERLINK / STABLE_SWAP_ADDRESS_ETHERLINK missing).");
}

// Create signer account
const signerAccount = privateKeyToAccount(PRIVATE_KEY as Hex);

type ChainKey = "base_sepolia" | "etherlink_shadownet";
type ChainConfig = {
  key: ChainKey;
  name: string;
  chainId: number;
  rpcUrl?: string;
  stableSwapAddress?: Address;
  idrxTokenAddress?: Address;
};

const CHAINS: Record<ChainKey, ChainConfig> = {
  base_sepolia: {
    key: "base_sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: RPC_URL,
    stableSwapAddress: STABLE_SWAP_ADDRESS,
    idrxTokenAddress: IDRX_TOKEN_ADDRESS,
  },
  etherlink_shadownet: {
    key: "etherlink_shadownet",
    name: "Etherlink Shadownet",
    chainId: 127823,
    rpcUrl: RPC_URL_ETHERLINK,
    stableSwapAddress: STABLE_SWAP_ADDRESS_ETHERLINK,
    idrxTokenAddress: IDRX_TOKEN_ADDRESS_ETHERLINK,
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

console.log("");
console.log("=====================================================");
console.log("   PAYMASTER SIGNER BACKEND");
console.log("=====================================================");
console.log("");
console.log(`   Signer Address: ${signerAccount.address}`);
console.log("   Make sure this address is added as authorized signer on Paymaster.");
console.log(`   Base StableSwap: ${STABLE_SWAP_ADDRESS}`);
if (STABLE_SWAP_ADDRESS_ETHERLINK) {
  console.log(`   Etherlink StableSwap: ${STABLE_SWAP_ADDRESS_ETHERLINK}`);
}
console.log("");

/**
 * Sign Paymaster Data
 *
 * hash = keccak256(abi.encode(payer, token, validUntil, validAfter))
 */
async function signPaymasterData(params: {
  payerAddress: Address;
  tokenAddress: Address;
  validUntil: number;
  validAfter: number;
  isActivation: boolean;
}): Promise<Hex> {
  const { payerAddress, tokenAddress, validUntil, validAfter, isActivation } = params;

  const hash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("address, address, uint256, uint256, bool"),
      [
        payerAddress,
        tokenAddress,
        BigInt(validUntil),
        BigInt(validAfter),
        isActivation,
      ]
    )
  );

  const signature = await signerAccount.signMessage({
    message: { raw: hash },
  });

  return signature;
}

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

// =====================================================
// ROUTES
// =====================================================

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    signerAddress: signerAccount.address,
    message: "Backend ready. Private key loaded.",
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
  res.json({
    signerAddress: signerAccount.address,
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
 *   isActivation: false
 * }
 */
app.post("/sign", async (req, res) => {
  try {
    const { payerAddress, tokenAddress, validUntil, validAfter, isActivation } = req.body;

    if (!payerAddress || !tokenAddress) {
      return res.status(400).json({
        error: "Missing required fields: payerAddress, tokenAddress",
      });
    }

    console.log("Signing request:");
    console.log(`   payer: ${payerAddress}`);
    console.log(`   token: ${tokenAddress}`);

    const signature = await signPaymasterData({
      payerAddress: payerAddress as Address,
      tokenAddress: tokenAddress as Address,
      validUntil: validUntil || Math.floor(Date.now() / 1000) + 3600,
      validAfter: validAfter || 0,
      isActivation: Boolean(isActivation),
    });

    console.log("   Signed!");

    res.json({ signature });
  } catch (error) {
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
  try {
    const tokenIn = requireAddress(req.query.tokenIn, "tokenIn");
    const tokenOut = requireAddress(req.query.tokenOut, "tokenOut");
    const amountIn = requireAmount(req.query.amountIn, "amountIn");
    const { chain, publicClient, stableSwapAddress } = getChainContext(req);

    const [amountOut, fee, totalUserPays] = (await publicClient.readContract({
      address: stableSwapAddress,
      abi: STABLE_SWAP_ABI,
      functionName: "getSwapQuote",
      args: [tokenIn, tokenOut, amountIn],
    })) as readonly [bigint, bigint, bigint];

    res.json({
      chain: chain.key,
      chainId: chain.chainId,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      fee: fee.toString(),
      totalUserPays: totalUserPays.toString(),
    });
  } catch (error) {
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
  try {
    const tokenIn = requireAddress(req.body?.tokenIn, "tokenIn");
    const tokenOut = requireAddress(req.body?.tokenOut, "tokenOut");
    const amountIn = requireAmount(req.body?.amountIn, "amountIn");
    const minAmountOut = requireAmount(req.body?.minAmountOut, "minAmountOut");
    const { chain, stableSwapAddress } = getChainContext(req);

    const data = encodeFunctionData({
      abi: STABLE_SWAP_ABI,
      functionName: "swap",
      args: [amountIn, tokenIn, tokenOut, minAmountOut],
    });

    res.json({
      chain: chain.key,
      chainId: chain.chainId,
      to: stableSwapAddress,
      data,
      value: "0",
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      note: "Use this calldata in your smart account / wallet tx",
    });
  } catch (error) {
    console.error("Build swap error:", error);
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
app.post("/topup-idrx", async (req, res) => {
  try {
    const { walletAddress, amount } = req.body;

    // Validate walletAddress is provided and is a valid Ethereum address
    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({
        error: "invalid_address",
        message: "walletAddress is required and must be a string",
      });
    }

    // Validate Ethereum address format (0x followed by 40 hex characters)
    const addressRegex = /^0x[0-9a-fA-F]{40}$/;
    if (!addressRegex.test(walletAddress)) {
      return res.status(400).json({
        error: "invalid_address",
        message: "walletAddress must be a valid Ethereum address",
      });
    }

    // Validate amount is provided
    if (amount === undefined || amount === null || amount === "") {
      return res.status(400).json({
        error: "invalid_amount",
        message: "amount is required",
      });
    }

    // Validate amount is a positive number
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
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
      return res.status(400).json({
        error: "chain_not_configured",
        message: error instanceof Error ? error.message : "Chain not configured",
      });
    }

    const { chain, publicClient } = chainContext;

    // Validate IDRX token address is configured for this chain
    if (!chain.idrxTokenAddress) {
      return res.status(400).json({
        error: "chain_not_configured",
        message: `IDRX token address not configured for chain: ${chain.key}`,
      });
    }

    console.log("Top-up IDRX request:");
    console.log(`   Chain: ${chain.name} (${chain.chainId})`);
    console.log(`   Wallet: ${walletAddress}`);
    console.log(`   Amount: ${amountNum} IDRX (${amountInWei} wei)`);
    console.log(`   IDRX Token: ${chain.idrxTokenAddress}`);

    // Call mint function on IDRX token contract
    try {
      const { createWalletClient } = await import("viem");
      const { http: httpTransport } = await import("viem");

      // Create wallet client for sending transactions
      const walletClient = createWalletClient({
        account: signerAccount,
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
        args: [walletAddress as Address, BigInt(amountInWei)],
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
      res.json({
        success: true,
        transactionHash: txHash,
        amount: amountNum.toString(),
        recipient: walletAddress,
        chain: chain.key,
        chainId: chain.chainId,
      });
    } catch (mintError) {
      console.error("   Mint transaction failed:", mintError);
      return res.status(500).json({
        error: "mint_failed",
        message: mintError instanceof Error ? mintError.message : "Failed to mint tokens",
      });
    }
  } catch (error) {
    console.error("Top-up error:", error);
    res.status(500).json({
      error: "topup_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  GET  /signer");
  console.log("  POST /sign");
  console.log("  GET  /swap/quote");
  console.log("  POST /swap/build");
  console.log("  POST /topup-idrx");
});
