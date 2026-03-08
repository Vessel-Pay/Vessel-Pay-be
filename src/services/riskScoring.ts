import { getAddress, type Address } from "viem";
import { invokeBedrockJson } from "./bedrockHelper.js";

type RiskLevel = "low" | "medium" | "high" | "critical";

type RiskAssessmentInput = {
    payerAddress: Address;
    tokenAddress: Address;
    isActivation: boolean;
    chain: "base_sepolia" | "etherlink_shadownet";
    clientId: string;
};

export type RiskAssessment = {
    score: number;
    level: RiskLevel;
    allowSponsoredGas: boolean;
    reasons: string[];
    recommendedAction: "allow" | "review" | "block";
};

const RISK_EXPLAINER_BEDROCK_MODEL_ID =
    process.env.RISK_EXPLAINER_BEDROCK_MODEL_ID?.trim() || process.env.COPILOT_BEDROCK_MODEL_ID?.trim() || "";

type VelocitySnapshot = {
    timestamps: number[];
};

const payerVelocity = new Map<string, VelocitySnapshot>();
const clientVelocity = new Map<string, VelocitySnapshot>();

const WINDOW_MS = 10 * 60 * 1000;

function pushAndCount(map: Map<string, VelocitySnapshot>, key: string): number {
    const now = Date.now();
    const entry = map.get(key) ?? { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((ts) => now - ts <= WINDOW_MS);
    entry.timestamps.push(now);
    map.set(key, entry);
    return entry.timestamps.length;
}

function scoreToLevel(score: number): RiskLevel {
    if (score >= 85) return "critical";
    if (score >= 65) return "high";
    if (score >= 35) return "medium";
    return "low";
}

function normalizeClientId(clientId: string): string {
    return clientId.trim().toLowerCase() || "unknown";
}

export function assessPaymasterRisk(input: RiskAssessmentInput): RiskAssessment {
    const payer = getAddress(input.payerAddress).toLowerCase();
    const token = getAddress(input.tokenAddress).toLowerCase();
    const client = normalizeClientId(input.clientId);

    const payerCount = pushAndCount(payerVelocity, payer);
    const clientCount = pushAndCount(clientVelocity, client);

    let score = 0;
    const reasons: string[] = [];

    if (input.isActivation) {
        score += 20;
        reasons.push("Activation flow has higher abuse surface");
    }

    if (payerCount >= 4) {
        score += 20;
        reasons.push(`High payer request velocity (${payerCount}/10m)`);
    }

    if (payerCount >= 8) {
        score += 20;
        reasons.push(`Very high payer request velocity (${payerCount}/10m)`);
    }

    if (clientCount >= 12) {
        score += 15;
        reasons.push(`High client/IP traffic (${clientCount}/10m)`);
    }

    if (clientCount >= 25) {
        score += 20;
        reasons.push(`Very high client/IP traffic (${clientCount}/10m)`);
    }

    // Basic deterministic token anomaly guard.
    if (token === "0x0000000000000000000000000000000000000000") {
        score += 30;
        reasons.push("Zero token address anomaly");
    }

    if (input.chain === "etherlink_shadownet") {
        score += 5;
        reasons.push("Experimental chain risk buffer");
    }

    const level = scoreToLevel(score);
    const allowSponsoredGas = level === "low" || level === "medium";
    const recommendedAction =
        level === "critical" || level === "high"
            ? "block"
            : level === "medium"
                ? "review"
                : "allow";

    return {
        score,
        level,
        allowSponsoredGas,
        reasons,
        recommendedAction,
    };
}

export async function generateRiskExplanation(input: {
    assessment: RiskAssessment;
    context: {
        payerAddress: Address;
        tokenAddress: Address;
        chain: "base_sepolia" | "etherlink_shadownet";
        isActivation: boolean;
    };
}): Promise<string> {
    const fallback =
        input.assessment.reasons.length > 0
            ? `Risk ${input.assessment.level} (${input.assessment.score}/100): ${input.assessment.reasons.join("; ")}. Action: ${input.assessment.recommendedAction}.`
            : `Risk ${input.assessment.level} (${input.assessment.score}/100). Action: ${input.assessment.recommendedAction}.`;

    if (!RISK_EXPLAINER_BEDROCK_MODEL_ID) {
        return fallback;
    }

    const response = await invokeBedrockJson<{ explanation?: string }>({
        modelId: RISK_EXPLAINER_BEDROCK_MODEL_ID,
        instruction:
            "You are a fintech risk analyst. Return JSON only with key explanation. Keep it concise, factual, and mention risk level and recommended action.",
        payload: {
            assessment: input.assessment,
            context: input.context,
        },
    });

    const rawExplanation = response?.explanation;
    if (typeof rawExplanation === "string" && rawExplanation.trim() !== "") {
        return rawExplanation.trim();
    }

    if (rawExplanation && typeof rawExplanation === "object") {
        const candidate = rawExplanation as {
            riskLevel?: unknown;
            description?: unknown;
            recommendedAction?: unknown;
            explanation?: unknown;
        };

        if (typeof candidate.explanation === "string" && candidate.explanation.trim() !== "") {
            return candidate.explanation.trim();
        }

        const parts: string[] = [];
        if (typeof candidate.riskLevel === "string" && candidate.riskLevel.trim() !== "") {
            parts.push(`Risk ${candidate.riskLevel.trim()}.`);
        }
        if (typeof candidate.description === "string" && candidate.description.trim() !== "") {
            parts.push(candidate.description.trim());
        }
        if (typeof candidate.recommendedAction === "string" && candidate.recommendedAction.trim() !== "") {
            parts.push(`Action: ${candidate.recommendedAction.trim()}.`);
        }

        if (parts.length > 0) {
            return parts.join(" ");
        }
    }

    return fallback;
}
