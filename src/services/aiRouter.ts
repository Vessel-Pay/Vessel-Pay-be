type ChainKey = "base_sepolia" | "etherlink_shadownet";

type QuoteSnapshot = {
    amountOut: string;
    fee: string;
    totalUserPays: string;
};

type QuoteByChain = Partial<Record<ChainKey, QuoteSnapshot>>;

type AdvisoryInput = {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    selectedChain: ChainKey;
    availableChains: ChainKey[];
    quotesByChain: QuoteByChain;
};

type ProviderAdvisory = {
    chain?: ChainKey;
    confidence?: number;
    reason?: string;
    estimatedFeeBps?: number;
    provider: "bedrock" | "sagemaker";
};

export type RoutingAdvisory = {
    enabled: boolean;
    source: "deterministic" | "bedrock" | "sagemaker";
    selectedChain: ChainKey;
    confidence: number;
    reason: string;
    guardrailsPassed: boolean;
    rejectedReason?: string;
    estimatedFeeBps?: number;
};

const ENABLE_AI_ROUTER = (process.env.ENABLE_AI_ROUTER ?? "false").toLowerCase() === "true";
const AI_ROUTER_STAGING_ONLY = (process.env.AI_ROUTER_STAGING_ONLY ?? "true").toLowerCase() === "true";
const APP_ENVIRONMENT = (process.env.ENVIRONMENT ?? "").toLowerCase();
const AI_CHAIN_ALLOWLIST = new Set(
    (process.env.AI_CHAIN_ALLOWLIST ?? "base_sepolia,etherlink_shadownet")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
);
const AI_FEE_CAP_BPS = Number.parseInt(process.env.AI_FEE_CAP_BPS ?? "100", 10);
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID?.trim() ?? "";
const SAGEMAKER_ENDPOINT_NAME = process.env.SAGEMAKER_ENDPOINT_NAME?.trim() ?? "";
const AI_ROUTER_PROVIDER = (process.env.AI_ROUTER_PROVIDER ?? "auto").toLowerCase();

let bedrockClient: unknown;
let bedrockInvokeCtor: new (...args: any[]) => any;
let bedrockLoadPromise: Promise<void> | undefined;

let sagemakerClient: unknown;
let sagemakerInvokeCtor: new (...args: any[]) => any;
let sagemakerLoadPromise: Promise<void> | undefined;

function isAiRouterActive(): boolean {
    if (!ENABLE_AI_ROUTER) {
        return false;
    }

    if (AI_ROUTER_STAGING_ONLY && APP_ENVIRONMENT !== "staging") {
        return false;
    }

    return true;
}

function isAllowedChain(chain: ChainKey, availableChains: ChainKey[]): boolean {
    return AI_CHAIN_ALLOWLIST.has(chain) && availableChains.includes(chain);
}

function computeFeeBps(amountIn: string, fee: string): number | undefined {
    try {
        const inBig = BigInt(amountIn);
        const feeBig = BigInt(fee);
        if (inBig <= 0n || feeBig < 0n) {
            return undefined;
        }

        return Number((feeBig * 10_000n) / inBig);
    } catch {
        return undefined;
    }
}

function resolveBestDeterministicChain(input: AdvisoryInput): ChainKey {
    let bestChain: ChainKey = input.selectedChain;
    let bestAmountOut = 0n;

    for (const chain of input.availableChains) {
        if (!isAllowedChain(chain, input.availableChains)) {
            continue;
        }

        const quote = input.quotesByChain[chain];
        if (!quote) {
            continue;
        }

        try {
            const amountOut = BigInt(quote.amountOut);
            if (amountOut > bestAmountOut) {
                bestAmountOut = amountOut;
                bestChain = chain;
            }
        } catch {
            // Ignore malformed quote values and continue.
        }
    }

    return bestChain;
}

function deterministicAdvisory(input: AdvisoryInput, reason: string): RoutingAdvisory {
    const selectedChain = resolveBestDeterministicChain(input);
    return {
        enabled: false,
        source: "deterministic",
        selectedChain,
        confidence: 1,
        reason,
        guardrailsPassed: true,
    };
}

function sanitizeProviderChain(chain: unknown): ChainKey | undefined {
    if (chain !== "base_sepolia" && chain !== "etherlink_shadownet") {
        return undefined;
    }
    return chain;
}

function parseProviderPayload(raw: unknown, provider: "bedrock" | "sagemaker"): ProviderAdvisory | undefined {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }

    const payload = raw as {
        chain?: unknown;
        recommendedChain?: unknown;
        confidence?: unknown;
        reason?: unknown;
        estimatedFeeBps?: unknown;
        feeBps?: unknown;
    };

    const chain = sanitizeProviderChain(payload.chain ?? payload.recommendedChain);
    const confidence =
        typeof payload.confidence === "number" && Number.isFinite(payload.confidence)
            ? Math.max(0, Math.min(1, payload.confidence))
            : undefined;

    const estimatedFeeBpsValue = payload.estimatedFeeBps ?? payload.feeBps;
    const estimatedFeeBps =
        typeof estimatedFeeBpsValue === "number" && Number.isFinite(estimatedFeeBpsValue)
            ? Math.max(0, Math.floor(estimatedFeeBpsValue))
            : undefined;

    return {
        provider,
        chain,
        confidence,
        reason: typeof payload.reason === "string" ? payload.reason : undefined,
        estimatedFeeBps,
    };
}

async function ensureBedrockLoaded(): Promise<void> {
    if (bedrockClient && bedrockInvokeCtor) {
        return;
    }

    if (bedrockLoadPromise) {
        return bedrockLoadPromise;
    }

    bedrockLoadPromise = (async () => {
        const module = await import("@aws-sdk/client-bedrock-runtime");
        const BedrockRuntimeClientCtor = module.BedrockRuntimeClient;
        bedrockInvokeCtor = module.InvokeModelCommand;
        bedrockClient = new BedrockRuntimeClientCtor({ region: process.env.AWS_REGION });
    })();

    return bedrockLoadPromise;
}

async function invokeBedrock(input: AdvisoryInput): Promise<ProviderAdvisory | undefined> {
    if (!BEDROCK_MODEL_ID) {
        return undefined;
    }

    try {
        await ensureBedrockLoaded();

        const prompt = {
            instruction:
                "Return JSON only with keys: recommendedChain, confidence, estimatedFeeBps, reason. recommendedChain must be one of base_sepolia or etherlink_shadownet.",
            payload: input,
        };

        const command = new bedrockInvokeCtor({
            modelId: BEDROCK_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(prompt),
        });

        const response = await (bedrockClient as {
            send: (cmd: unknown) => Promise<{ body?: Uint8Array }>;
        }).send(command);

        if (!response.body) {
            return undefined;
        }

        const decoded = new TextDecoder().decode(response.body);
        const parsed = JSON.parse(decoded) as unknown;

        // Some models wrap content under output/message fields.
        if (parsed && typeof parsed === "object") {
            const wrapped = parsed as { output?: unknown; message?: unknown; content?: unknown };
            if (wrapped.output && typeof wrapped.output === "object") {
                return parseProviderPayload(wrapped.output, "bedrock");
            }
            if (wrapped.message && typeof wrapped.message === "object") {
                return parseProviderPayload(wrapped.message, "bedrock");
            }
            if (wrapped.content && typeof wrapped.content === "object") {
                return parseProviderPayload(wrapped.content, "bedrock");
            }
        }

        return parseProviderPayload(parsed, "bedrock");
    } catch {
        return undefined;
    }
}

async function ensureSagemakerLoaded(): Promise<void> {
    if (sagemakerClient && sagemakerInvokeCtor) {
        return;
    }

    if (sagemakerLoadPromise) {
        return sagemakerLoadPromise;
    }

    sagemakerLoadPromise = (async () => {
        const module = await import("@aws-sdk/client-sagemaker-runtime");
        const SageMakerRuntimeClientCtor = module.SageMakerRuntimeClient;
        sagemakerInvokeCtor = module.InvokeEndpointCommand;
        sagemakerClient = new SageMakerRuntimeClientCtor({ region: process.env.AWS_REGION });
    })();

    return sagemakerLoadPromise;
}

async function invokeSagemaker(input: AdvisoryInput): Promise<ProviderAdvisory | undefined> {
    if (!SAGEMAKER_ENDPOINT_NAME) {
        return undefined;
    }

    try {
        await ensureSagemakerLoaded();

        const command = new sagemakerInvokeCtor({
            EndpointName: SAGEMAKER_ENDPOINT_NAME,
            ContentType: "application/json",
            Body: JSON.stringify(input),
        });

        const response = await (sagemakerClient as {
            send: (cmd: unknown) => Promise<{ Body?: Uint8Array }>;
        }).send(command);

        if (!response.Body) {
            return undefined;
        }

        const decoded = new TextDecoder().decode(response.Body);
        const parsed = JSON.parse(decoded) as unknown;
        return parseProviderPayload(parsed, "sagemaker");
    } catch {
        return undefined;
    }
}

function runGuardrails(input: AdvisoryInput, providerResult: ProviderAdvisory): {
    accepted: boolean;
    selectedChain: ChainKey;
    rejectedReason?: string;
    estimatedFeeBps?: number;
} {
    const fallbackChain = resolveBestDeterministicChain(input);

    if (!providerResult.chain) {
        return {
            accepted: false,
            selectedChain: fallbackChain,
            rejectedReason: "missing_recommended_chain",
        };
    }

    if (!isAllowedChain(providerResult.chain, input.availableChains)) {
        return {
            accepted: false,
            selectedChain: fallbackChain,
            rejectedReason: "chain_not_allowlisted",
            estimatedFeeBps: providerResult.estimatedFeeBps,
        };
    }

    const quote = input.quotesByChain[providerResult.chain];
    if (!quote) {
        return {
            accepted: false,
            selectedChain: fallbackChain,
            rejectedReason: "missing_quote_for_recommended_chain",
            estimatedFeeBps: providerResult.estimatedFeeBps,
        };
    }

    const effectiveFeeBps =
        providerResult.estimatedFeeBps ?? computeFeeBps(input.amountIn, quote.fee);

    if (typeof effectiveFeeBps === "number" && effectiveFeeBps > AI_FEE_CAP_BPS) {
        return {
            accepted: false,
            selectedChain: fallbackChain,
            rejectedReason: "fee_cap_exceeded",
            estimatedFeeBps: effectiveFeeBps,
        };
    }

    return {
        accepted: true,
        selectedChain: providerResult.chain,
        estimatedFeeBps: effectiveFeeBps,
    };
}

export async function getRoutingAdvisory(input: AdvisoryInput): Promise<RoutingAdvisory> {
    if (!isAiRouterActive()) {
        return deterministicAdvisory(input, "AI router disabled; deterministic fallback used");
    }

    let providerResult: ProviderAdvisory | undefined;

    if (AI_ROUTER_PROVIDER === "bedrock" || AI_ROUTER_PROVIDER === "auto") {
        providerResult = await invokeBedrock(input);
    }

    if (!providerResult && (AI_ROUTER_PROVIDER === "sagemaker" || AI_ROUTER_PROVIDER === "auto")) {
        providerResult = await invokeSagemaker(input);
    }

    if (!providerResult) {
        const fallback = deterministicAdvisory(input, "AI provider unavailable; deterministic fallback used");
        return {
            ...fallback,
            enabled: true,
        };
    }

    const guardrailResult = runGuardrails(input, providerResult);

    return {
        enabled: true,
        source: providerResult.provider,
        selectedChain: guardrailResult.selectedChain,
        confidence: providerResult.confidence ?? 0.5,
        reason: providerResult.reason ?? "AI advisory evaluated",
        guardrailsPassed: guardrailResult.accepted,
        rejectedReason: guardrailResult.rejectedReason,
        estimatedFeeBps: guardrailResult.estimatedFeeBps,
    };
}
