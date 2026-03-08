import { invokeBedrockJson } from "./bedrockHelper.js";

type KiroPlanStep = {
    id: string;
    title: string;
    outcome: string;
};

type KiroPlan = {
    mode: "kiro";
    summary: string;
    steps: KiroPlanStep[];
};

type KiroPlanInput = {
    goal: string;
    context?: Record<string, unknown>;
};

function fallbackPlan(goal: string): KiroPlan {
    const cleanGoal = goal.trim();
    return {
        mode: "kiro",
        summary: `Deterministic Kiro fallback plan for: ${cleanGoal}`,
        steps: [
            {
                id: "discover",
                title: "Gather context",
                outcome: "Collect relevant code, infra, and runtime constraints.",
            },
            {
                id: "design",
                title: "Design implementation",
                outcome: "Define service contracts, guardrails, and expected outputs.",
            },
            {
                id: "execute",
                title: "Implement and verify",
                outcome: "Ship changes with test/build verification evidence.",
            },
        ],
    };
}

export async function generateKiroPlan(input: KiroPlanInput): Promise<KiroPlan> {
    const modelId =
        process.env.KIRO_BEDROCK_MODEL_ID?.trim() ||
        process.env.COPILOT_BEDROCK_MODEL_ID?.trim() ||
        process.env.BEDROCK_MODEL_ID?.trim() ||
        "";

    if (!modelId) {
        return fallbackPlan(input.goal);
    }

    const response = await invokeBedrockJson<KiroPlan>({
        modelId,
        instruction:
            "You are Kiro workflow planner. Return JSON with keys: mode, summary, steps[]. Each step must include id, title, outcome. mode must be 'kiro'. Keep between 3 and 6 steps.",
        payload: {
            goal: input.goal,
            context: input.context ?? {},
        },
    });

    if (!response || !Array.isArray(response.steps) || response.steps.length === 0) {
        return fallbackPlan(input.goal);
    }

    return {
        mode: "kiro",
        summary:
            typeof response.summary === "string" && response.summary.trim() !== ""
                ? response.summary
                : `Kiro plan for: ${input.goal}`,
        steps: response.steps
            .map((step) => ({
                id:
                    typeof step?.id === "string" && step.id.trim() !== ""
                        ? step.id
                        : "step",
                title:
                    typeof step?.title === "string" && step.title.trim() !== ""
                        ? step.title
                        : "Planned step",
                outcome:
                    typeof step?.outcome === "string" && step.outcome.trim() !== ""
                        ? step.outcome
                        : "Expected outcome to be defined.",
            }))
            .slice(0, 6),
    };
}
