type AgentCoreInput = {
    inputText: string;
    sessionId?: string;
    userId?: string;
};

type AgentCoreResult = {
    sessionId: string;
    outputText: string;
};

let agentClient: unknown;
let invokeAgentCtor: new (...args: any[]) => any;
let loadPromise: Promise<void> | undefined;

async function ensureLoaded(): Promise<void> {
    if (agentClient && invokeAgentCtor) {
        return;
    }

    if (loadPromise) {
        return loadPromise;
    }

    loadPromise = (async () => {
        const module = await import("@aws-sdk/client-bedrock-agent-runtime");
        const BedrockAgentRuntimeClientCtor = module.BedrockAgentRuntimeClient;
        invokeAgentCtor = module.InvokeAgentCommand;

        agentClient = new BedrockAgentRuntimeClientCtor({
            region: process.env.AWS_REGION || "us-east-1",
        });
    })();

    return loadPromise;
}

function resolveAgentConfig(): { agentId: string; agentAliasId: string } {
    const agentId =
        process.env.AGENTCORE_AGENT_ID?.trim() ||
        process.env.BEDROCK_AGENT_ID?.trim() ||
        "";
    const agentAliasId =
        process.env.AGENTCORE_AGENT_ALIAS_ID?.trim() ||
        process.env.BEDROCK_AGENT_ALIAS_ID?.trim() ||
        "";

    if (!agentId || !agentAliasId) {
        throw new Error(
            "AGENTCORE_AGENT_ID and AGENTCORE_AGENT_ALIAS_ID must be configured"
        );
    }

    return { agentId, agentAliasId };
}

export function isAgentCoreConfigured(): boolean {
    const agentId =
        process.env.AGENTCORE_AGENT_ID?.trim() ||
        process.env.BEDROCK_AGENT_ID?.trim() ||
        "";
    const agentAliasId =
        process.env.AGENTCORE_AGENT_ALIAS_ID?.trim() ||
        process.env.BEDROCK_AGENT_ALIAS_ID?.trim() ||
        "";
    return agentId !== "" && agentAliasId !== "";
}

async function collectAgentOutput(completion: unknown): Promise<string> {
    if (!completion || typeof completion !== "object") {
        return "";
    }

    const iterableCandidate = completion as {
        [Symbol.asyncIterator]?: unknown;
    };
    if (typeof iterableCandidate[Symbol.asyncIterator] !== "function") {
        return "";
    }

    const maybeIterable = completion as AsyncIterable<{
        chunk?: {
            bytes?: Uint8Array;
        };
        trace?: unknown;
    }>;

    const chunks: string[] = [];
    for await (const event of maybeIterable) {
        const bytes = event?.chunk?.bytes;
        if (bytes && bytes.length > 0) {
            chunks.push(new TextDecoder().decode(bytes));
        }
    }

    return chunks.join("").trim();
}

export async function runAgentCore(input: AgentCoreInput): Promise<AgentCoreResult> {
    const { agentId, agentAliasId } = resolveAgentConfig();
    await ensureLoaded();

    const generatedSessionId = `agentcore-${Date.now()}`;
    const sessionId = input.sessionId?.trim() || generatedSessionId;

    const command = new invokeAgentCtor({
        agentId,
        agentAliasId,
        sessionId,
        inputText: input.inputText,
        enableTrace: false,
        endSession: false,
        sessionState:
            input.userId && input.userId.trim() !== ""
                ? {
                    sessionAttributes: {
                        userId: input.userId.trim(),
                    },
                }
                : undefined,
    });

    const response = await (agentClient as {
        send: (cmd: unknown) => Promise<{
            completion?: unknown;
            sessionId?: string;
        }>;
    }).send(command);

    const outputText = await collectAgentOutput(response.completion);

    return {
        sessionId: response.sessionId ?? sessionId,
        outputText,
    };
}
