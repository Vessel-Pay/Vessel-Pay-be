type BedrockInvokeOptions = {
    modelId: string;
    instruction: string;
    payload: unknown;
};

let bedrockClient: unknown;
let converseCtor: new (...args: any[]) => any;
let loadPromise: Promise<void> | undefined;

async function ensureLoaded(): Promise<void> {
    if (bedrockClient && converseCtor) {
        return;
    }

    if (loadPromise) {
        return loadPromise;
    }

    loadPromise = (async () => {
        const module = await import("@aws-sdk/client-bedrock-runtime");
        const BedrockRuntimeClientCtor = module.BedrockRuntimeClient;
        converseCtor = module.ConverseCommand;
        bedrockClient = new BedrockRuntimeClientCtor({
            region: process.env.AWS_REGION || "us-east-1",
        });
    })();

    return loadPromise;
}

function parseMaybeJson(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    try {
        return JSON.parse(trimmed);
    } catch {
        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            const sliced = trimmed.slice(firstBrace, lastBrace + 1);
            try {
                return JSON.parse(sliced);
            } catch {
                return undefined;
            }
        }
        return undefined;
    }
}

function unwrapModelPayload(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") {
        return payload;
    }

    const wrapped = payload as {
        output?: unknown;
        message?: unknown;
        content?: unknown;
        completion?: unknown;
        generated_text?: unknown;
        text?: unknown;
    };

    const candidates = [
        wrapped.output,
        wrapped.message,
        wrapped.content,
        wrapped.completion,
        wrapped.generated_text,
        wrapped.text,
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;

        if (typeof candidate === "string") {
            const parsed = parseMaybeJson(candidate);
            if (parsed) return parsed;
            continue;
        }

        if (typeof candidate === "object") {
            return candidate;
        }
    }

    return payload;
}

function extractTextFromConverse(output: unknown): string {
    if (!output || typeof output !== "object") {
        return "";
    }

    const outputObj = output as {
        message?: {
            content?: Array<{ text?: string }>;
        };
    };

    const content = outputObj.message?.content;
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((block) => (typeof block?.text === "string" ? block.text : ""))
        .join("\n")
        .trim();
}

export async function invokeBedrockJson<T>(
    options: BedrockInvokeOptions
): Promise<T | undefined> {
    if (!options.modelId.trim()) {
        return undefined;
    }

    try {
        await ensureLoaded();

        const userPrompt = [
            options.instruction.trim(),
            "Return valid JSON only.",
            `Input JSON: ${JSON.stringify(options.payload)}`,
        ].join("\n\n");

        const command = new converseCtor({
            modelId: options.modelId,
            messages: [
                {
                    role: "user",
                    content: [{ text: userPrompt }],
                },
            ],
            inferenceConfig: {
                maxTokens: 500,
                temperature: 0.2,
            },
        });

        const response = await (bedrockClient as {
            send: (cmd: unknown) => Promise<{ output?: unknown }>;
        }).send(command);

        const text = extractTextFromConverse(response.output);
        if (!text) {
            return undefined;
        }

        const parsed = parseMaybeJson(text);
        if (!parsed) {
            return undefined;
        }

        const unwrapped = unwrapModelPayload(parsed);
        if (!unwrapped || typeof unwrapped !== "object") {
            return undefined;
        }

        return unwrapped as T;
    } catch (error) {
        console.warn(
            `Bedrock invocation failed for model ${options.modelId}: ${error instanceof Error ? error.message : "unknown"
            }`
        );
        return undefined;
    }
}
