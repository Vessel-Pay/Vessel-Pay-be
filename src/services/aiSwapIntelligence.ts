import { createHash } from "node:crypto";

type ChainKey = "base_sepolia" | "etherlink_shadownet";

type QuoteSnapshot = {
    amountOut: string;
    fee: string;
    totalUserPays: string;
};

type QuoteByChain = Partial<Record<ChainKey, QuoteSnapshot>>;

type AdvisoryLike = {
    selectedChain: ChainKey;
    guardrailsPassed: boolean;
    source: "deterministic" | "bedrock" | "sagemaker";
    reason: string;
};

export type SwapIntelligenceSummary = {
    measurableGain: boolean;
    baselineChain: ChainKey;
    recommendedChain: ChainKey;
    estimatedGainAmountOut: string;
    estimatedGainBps: number;
    recommendationStrength: "low" | "medium" | "high";
    reason: string;
    modelSource: AdvisoryLike["source"];
};

export type AiExperimentVariant = "control" | "treatment";

export type AiExperimentAssignment = {
    experimentId: string;
    variant: AiExperimentVariant;
    subject: string;
};

const DEFAULT_EXPERIMENT_ID = process.env.AI_EXPERIMENT_ID?.trim() || "swap_intelligence_v2";

function safeBigInt(value: string | undefined): bigint | undefined {
    if (!value) return undefined;
    try {
        return BigInt(value);
    } catch {
        return undefined;
    }
}

function toStrength(bps: number): "low" | "medium" | "high" {
    if (bps >= 100) return "high";
    if (bps >= 30) return "medium";
    return "low";
}

export function computeSwapIntelligenceSummary(input: {
    requestedChain: ChainKey;
    advisory: AdvisoryLike;
    quotesByChain: QuoteByChain;
}): SwapIntelligenceSummary {
    const baselineChain = input.requestedChain;
    const recommendedChain = input.advisory.selectedChain;

    const baselineAmountOut = safeBigInt(input.quotesByChain[baselineChain]?.amountOut) ?? 0n;
    const recommendedAmountOut =
        safeBigInt(input.quotesByChain[recommendedChain]?.amountOut) ?? baselineAmountOut;

    const gainAmountOut = recommendedAmountOut - baselineAmountOut;
    const gainBps =
        baselineAmountOut > 0n
            ? Number((gainAmountOut * 10_000n) / baselineAmountOut)
            : 0;

    const measurableGain = gainAmountOut > 0n && input.advisory.guardrailsPassed;

    return {
        measurableGain,
        baselineChain,
        recommendedChain,
        estimatedGainAmountOut: gainAmountOut > 0n ? gainAmountOut.toString() : "0",
        estimatedGainBps: gainBps > 0 ? gainBps : 0,
        recommendationStrength: toStrength(gainBps > 0 ? gainBps : 0),
        reason: measurableGain
            ? `Expected improvement of ${gainBps} bps vs requested chain`
            : input.advisory.reason,
        modelSource: input.advisory.source,
    };
}

export function assignAiExperimentVariant(subject: string): AiExperimentAssignment {
    const normalizedSubject = subject.trim().toLowerCase() || "unknown";
    const digest = createHash("sha256").update(`${DEFAULT_EXPERIMENT_ID}:${normalizedSubject}`).digest("hex");
    const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;

    return {
        experimentId: DEFAULT_EXPERIMENT_ID,
        variant: bucket < 50 ? "control" : "treatment",
        subject: normalizedSubject,
    };
}
