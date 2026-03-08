type SagemakerInferenceInput = {
    payload: unknown;
    endpointName?: string;
    contentType?: string;
};

type SagemakerInferenceResult = {
    endpointName: string;
    contentType: string;
    response: unknown;
};

export function isSagemakerInferenceConfigured(endpointName?: string): boolean {
    const resolvedEndpointName =
        endpointName?.trim() || process.env.SAGEMAKER_ENDPOINT_NAME?.trim() || "";
    return resolvedEndpointName !== "";
}

let runtimeClient: unknown;
let invokeEndpointCtor: new (...args: any[]) => any;
let loadPromise: Promise<void> | undefined;

async function ensureLoaded(): Promise<void> {
    if (runtimeClient && invokeEndpointCtor) {
        return;
    }

    if (loadPromise) {
        return loadPromise;
    }

    loadPromise = (async () => {
        const module = await import("@aws-sdk/client-sagemaker-runtime");
        const SageMakerRuntimeClientCtor = module.SageMakerRuntimeClient;
        invokeEndpointCtor = module.InvokeEndpointCommand;

        runtimeClient = new SageMakerRuntimeClientCtor({
            region: process.env.AWS_REGION || "us-east-1",
        });
    })();

    return loadPromise;
}

function parseBody(body: Uint8Array): unknown {
    const text = new TextDecoder().decode(body);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

export async function runSagemakerInference(
    input: SagemakerInferenceInput
): Promise<SagemakerInferenceResult> {
    const endpointName =
        input.endpointName?.trim() || process.env.SAGEMAKER_ENDPOINT_NAME?.trim() || "";

    if (!endpointName) {
        throw new Error("SAGEMAKER_ENDPOINT_NAME is not configured");
    }

    await ensureLoaded();

    const contentType = input.contentType?.trim() || "application/json";
    const body =
        contentType === "application/json"
            ? JSON.stringify(input.payload ?? {})
            : String(input.payload ?? "");

    const command = new invokeEndpointCtor({
        EndpointName: endpointName,
        ContentType: contentType,
        Body: body,
    });

    const response = await (runtimeClient as {
        send: (cmd: unknown) => Promise<{ Body?: Uint8Array }>;
    }).send(command);

    if (!response.Body) {
        return {
            endpointName,
            contentType,
            response: null,
        };
    }

    return {
        endpointName,
        contentType,
        response: parseBody(response.Body),
    };
}
