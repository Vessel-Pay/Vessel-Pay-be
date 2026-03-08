import { invokeBedrockJson } from "./bedrockHelper.js";

type CopilotIntent =
    | "swap"
    | "send"
    | "topup"
    | "balance"
    | "unknown";

export type CopilotActionPlan = {
    intent: CopilotIntent;
    confidence: number;
    summary: string;
    extracted: {
        amount?: string;
        tokenIn?: string;
        tokenOut?: string;
        recipient?: string;
        chain?: "base_sepolia" | "etherlink_shadownet";
    };
    steps: string[];
    modelSource?: "heuristic" | "bedrock";
};

const COPILOT_BEDROCK_MODEL_ID = process.env.COPILOT_BEDROCK_MODEL_ID?.trim() ?? "";

const TOKENS = [
    "USDC",
    "USDT",
    "USDS",
    "IDRX",
    "EURC",
    "BRZ",
    "AUDD",
    "CADC",
    "ZCHF",
    "TGBP",
];

function findFirstToken(text: string): string | undefined {
    const token = TOKENS.find((symbol) => new RegExp(`\\b${symbol}\\b`, "i").test(text));
    return token?.toUpperCase();
}

function findAllTokens(text: string): string[] {
    return TOKENS.filter((symbol) => new RegExp(`\\b${symbol}\\b`, "i").test(text)).map((item) =>
        item.toUpperCase()
    );
}

function extractAmount(text: string): string | undefined {
    const match = text.match(/(\d+(?:\.\d+)?)/);
    return match?.[1];
}

function extractAddress(text: string): string | undefined {
    const match = text.match(/0x[a-fA-F0-9]{40}/);
    return match?.[0];
}

function extractChain(text: string): "base_sepolia" | "etherlink_shadownet" | undefined {
    const lower = text.toLowerCase();
    if (lower.includes("base")) return "base_sepolia";
    if (lower.includes("etherlink") || lower.includes("shadownet")) return "etherlink_shadownet";
    return undefined;
}

function buildHeuristicCopilotActionPlan(prompt: string): CopilotActionPlan {
    const text = prompt.trim();
    const lower = text.toLowerCase();

    const amount = extractAmount(text);
    const tokens = findAllTokens(text);
    const recipient = extractAddress(text);
    const chain = extractChain(text);

    if (lower.includes("swap") || lower.includes("convert")) {
        const tokenIn = tokens[0] ?? findFirstToken(text);
        const tokenOut = tokens[1];
        return {
            intent: "swap",
            confidence: 0.88,
            summary: "Swap intent detected. I prepared an optimized swap plan.",
            extracted: { amount, tokenIn, tokenOut, chain },
            steps: [
                "Fetch multi-chain quote with AI advisory",
                "Review expected output + fee + confidence",
                "Build calldata with auto-route",
                "Sign and submit sponsored transaction",
            ],
            modelSource: "heuristic",
        };
    }

    if (lower.includes("send") || lower.includes("transfer") || recipient) {
        const tokenIn = tokens[0] ?? findFirstToken(text);
        return {
            intent: "send",
            confidence: 0.84,
            summary: "Transfer intent detected. I prepared a secure send flow.",
            extracted: { amount, tokenIn, recipient, chain },
            steps: [
                "Validate recipient + token",
                "Estimate network and sponsored gas viability",
                "Assemble transfer transaction",
                "Sign and broadcast with receipt tracking",
            ],
            modelSource: "heuristic",
        };
    }

    if (lower.includes("topup") || lower.includes("faucet") || lower.includes("mint")) {
        return {
            intent: "topup",
            confidence: 0.8,
            summary: "Top-up intent detected. I prepared faucet activation steps.",
            extracted: { amount, tokenIn: tokens[0], recipient, chain },
            steps: [
                "Check activation and anti-abuse limits",
                "Generate top-up request",
                "Submit mint/topup transaction",
                "Verify token balance update",
            ],
            modelSource: "heuristic",
        };
    }

    if (lower.includes("balance") || lower.includes("portfolio") || lower.includes("holdings")) {
        return {
            intent: "balance",
            confidence: 0.76,
            summary: "Portfolio intent detected. I prepared a balance-inspection flow.",
            extracted: { tokenIn: tokens[0], chain },
            steps: [
                "Read smart-account balances across supported chains",
                "Normalize token units",
                "Return summary with highest-value holdings",
            ],
            modelSource: "heuristic",
        };
    }

    return {
        intent: "unknown",
        confidence: 0.4,
        summary: "Intent unclear. Ask for action, token, amount, and destination.",
        extracted: { amount, tokenIn: tokens[0], tokenOut: tokens[1], recipient, chain },
        steps: [
            "Clarify user goal (swap/send/topup)",
            "Collect missing amount and token",
            "Confirm chain preference",
        ],
        modelSource: "heuristic",
    };
}

function sanitizeIntent(intent: unknown): CopilotIntent {
    if (intent === "swap" || intent === "send" || intent === "topup" || intent === "balance") {
        return intent;
    }
    return "unknown";
}

export async function buildCopilotActionPlan(prompt: string): Promise<CopilotActionPlan> {
    const fallback = buildHeuristicCopilotActionPlan(prompt);

    if (!COPILOT_BEDROCK_MODEL_ID) {
        return fallback;
    }

    const bedrock = await invokeBedrockJson<Partial<CopilotActionPlan>>({
        modelId: COPILOT_BEDROCK_MODEL_ID,
        instruction:
            "Classify payment intent and return JSON only with keys: intent, confidence, summary, extracted, steps. intent must be one of swap|send|topup|balance|unknown.",
        payload: {
            prompt,
            supportedChains: ["base_sepolia", "etherlink_shadownet"],
            supportedTokens: TOKENS,
        },
    });

    if (!bedrock) {
        return fallback;
    }

    const steps = Array.isArray(bedrock.steps)
        ? bedrock.steps.filter((item): item is string => typeof item === "string" && item.trim() !== "")
        : [];

    return {
        intent: sanitizeIntent(bedrock.intent),
        confidence:
            typeof bedrock.confidence === "number" && Number.isFinite(bedrock.confidence)
                ? Math.max(0, Math.min(1, bedrock.confidence))
                : fallback.confidence,
        summary: typeof bedrock.summary === "string" && bedrock.summary.trim() !== ""
            ? bedrock.summary
            : fallback.summary,
        extracted: {
            amount: typeof bedrock.extracted?.amount === "string" ? bedrock.extracted.amount : fallback.extracted.amount,
            tokenIn: typeof bedrock.extracted?.tokenIn === "string" ? bedrock.extracted.tokenIn : fallback.extracted.tokenIn,
            tokenOut: typeof bedrock.extracted?.tokenOut === "string" ? bedrock.extracted.tokenOut : fallback.extracted.tokenOut,
            recipient: typeof bedrock.extracted?.recipient === "string" ? bedrock.extracted.recipient : fallback.extracted.recipient,
            chain:
                bedrock.extracted?.chain === "base_sepolia" || bedrock.extracted?.chain === "etherlink_shadownet"
                    ? bedrock.extracted.chain
                    : fallback.extracted.chain,
        },
        steps: steps.length > 0 ? steps : fallback.steps,
        modelSource: "bedrock",
    };
}
