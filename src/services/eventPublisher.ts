type EventType = "swapCompleted" | "walletActivated" | "transactionFailed";

type EventPayload = Record<string, unknown>;

type PublishResult = {
    published: boolean;
    messageId?: string;
};

const SNS_EVENTS_TOPIC_ARN = process.env.SNS_EVENTS_TOPIC_ARN?.trim();

let snsClient: unknown;
let publishCommandCtor: new (...args: any[]) => any;
let snsLoadPromise: Promise<void> | undefined;

async function ensureSnsLoaded(): Promise<void> {
    if (snsClient && publishCommandCtor) {
        return;
    }

    if (snsLoadPromise) {
        return snsLoadPromise;
    }

    snsLoadPromise = (async () => {
        const snsModule = await import("@aws-sdk/client-sns");
        const SNSClientCtor = snsModule.SNSClient;
        publishCommandCtor = snsModule.PublishCommand;
        snsClient = new SNSClientCtor({ region: process.env.AWS_REGION });
    })();

    return snsLoadPromise;
}

export async function publishDomainEvent(eventType: EventType, payload: EventPayload): Promise<PublishResult> {
    if (!SNS_EVENTS_TOPIC_ARN) {
        return { published: false };
    }

    try {
        await ensureSnsLoaded();

        const message = JSON.stringify({
            eventType,
            timestamp: new Date().toISOString(),
            ...payload,
        });

        const command = new publishCommandCtor({
            TopicArn: SNS_EVENTS_TOPIC_ARN,
            Subject: `vessel.${eventType}`,
            Message: message,
            MessageAttributes: {
                eventType: {
                    DataType: "String",
                    StringValue: eventType,
                },
            },
        });

        const response = await (snsClient as { send: (cmd: unknown) => Promise<{ MessageId?: string }> }).send(command);
        return { published: true, messageId: response.MessageId };
    } catch (error) {
        console.warn(
            JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "warn",
                service: "eventPublisher",
                eventType,
                result: "failure",
                errorClass: error instanceof Error ? error.name : "UnknownError",
                message: error instanceof Error ? error.message : "Failed to publish SNS event",
            })
        );
        return { published: false };
    }
}

export async function publishSwapCompleted(payload: EventPayload): Promise<PublishResult> {
    return publishDomainEvent("swapCompleted", payload);
}

export async function publishWalletActivated(payload: EventPayload): Promise<PublishResult> {
    return publishDomainEvent("walletActivated", payload);
}

export async function publishTransactionFailed(payload: EventPayload): Promise<PublishResult> {
    return publishDomainEvent("transactionFailed", payload);
}
