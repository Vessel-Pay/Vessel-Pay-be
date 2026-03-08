import { createHash } from "node:crypto";
import {
    DynamoDBClient,
    ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

type IdempotencyStatus = "IN_PROGRESS" | "SUCCEEDED" | "FAILED";

type UserOperationRecord = {
    operationHash: string;
    signature: string;
    payerAddress: string;
    tokenAddress: string;
    validUntil: number;
    validAfter: number;
    isActivation: boolean;
    chain: string;
    idempotencyKey?: string;
    status?: "RECEIVED" | "SUBMITTED" | "CONFIRMED" | "FAILED";
    ttl?: number;
};

type SwapHistoryRecord = {
    swapId?: string;
    chain: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    minAmountOut: string;
    to: string;
    status?: string;
    createdAt?: string;
    ttl?: number;
};

type WalletActivationRecord = {
    chain: string;
    transactionHash: string;
    amount: string;
};

type TopupIdempotencyRecord = {
    operationHash: string;
    requestType: "TOPUP_IDEMPOTENCY";
    walletAddress: string;
    chain: string;
    idempotencyKey: string;
    status: IdempotencyStatus;
    httpStatusCode?: number;
    responsePayload?: Record<string, unknown>;
    errorPayload?: Record<string, unknown>;
    ttl: number;
    createdAt: string;
    updatedAt: string;
};

export type AiTelemetryRecord = {
    telemetryId: string;
    experimentId: string;
    variant: "control" | "treatment";
    endpoint: string;
    requestedChain: string;
    recommendedChain: string;
    measurableGain: boolean;
    estimatedGainBps: number;
    modelSource: string;
    chain: string;
    createdAt: string;
    ttl: number;
};

export class PersistenceService {
    private readonly userOperationsTable?: string;
    private readonly swapHistoryTable?: string;
    private readonly walletActivationsTable?: string;
    private readonly aiTelemetryTable?: string;
    private readonly docClient?: DynamoDBDocumentClient;

    constructor() {
        this.userOperationsTable = process.env.USER_OPERATIONS_TABLE;
        this.swapHistoryTable = process.env.SWAP_HISTORY_TABLE;
        this.walletActivationsTable = process.env.WALLET_ACTIVATIONS_TABLE;
        this.aiTelemetryTable = process.env.AI_TELEMETRY_TABLE;

        if (this.userOperationsTable || this.swapHistoryTable || this.walletActivationsTable || this.aiTelemetryTable) {
            const client = new DynamoDBClient({ region: process.env.AWS_REGION });
            this.docClient = DynamoDBDocumentClient.from(client);
        }
    }

    isEnabled(): boolean {
        return Boolean(this.docClient);
    }

    private computeTtl(secondsFromNow = DEFAULT_TTL_SECONDS): number {
        return Math.floor(Date.now() / 1000) + secondsFromNow;
    }

    buildOperationHash(input: {
        payerAddress: string;
        tokenAddress: string;
        validUntil: number;
        validAfter: number;
        isActivation: boolean;
        chain: string;
    }): string {
        const canonical = JSON.stringify({
            payerAddress: input.payerAddress.toLowerCase(),
            tokenAddress: input.tokenAddress.toLowerCase(),
            validUntil: input.validUntil,
            validAfter: input.validAfter,
            isActivation: input.isActivation,
            chain: input.chain,
        });

        return createHash("sha256").update(canonical).digest("hex");
    }

    async getUserOperation(operationHash: string): Promise<UserOperationRecord | null> {
        if (!this.docClient || !this.userOperationsTable) {
            return null;
        }

        const response = await this.docClient.send(
            new GetCommand({
                TableName: this.userOperationsTable,
                Key: { operationHash },
            })
        );

        const item = response.Item as (UserOperationRecord & { requestType?: string }) | undefined;
        if (!item || item.requestType === "TOPUP_IDEMPOTENCY") {
            return null;
        }

        return item;
    }

    async putUserOperation(record: UserOperationRecord): Promise<"stored" | "already_exists"> {
        if (!this.docClient || !this.userOperationsTable) {
            return "already_exists";
        }

        try {
            await this.docClient.send(
                new PutCommand({
                    TableName: this.userOperationsTable,
                    Item: {
                        ...record,
                        status: record.status ?? "RECEIVED",
                        ttl: record.ttl ?? this.computeTtl(),
                        createdAt: new Date().toISOString(),
                    },
                    ConditionExpression: "attribute_not_exists(operationHash)",
                })
            );
            return "stored";
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                return "already_exists";
            }
            throw error;
        }
    }

    buildTopupOperationHash(input: {
        walletAddress: string;
        chain: string;
        idempotencyKey: string;
    }): string {
        const canonical = JSON.stringify({
            requestType: "TOPUP_IDEMPOTENCY",
            walletAddress: input.walletAddress.toLowerCase(),
            chain: input.chain,
            idempotencyKey: input.idempotencyKey,
        });

        return createHash("sha256").update(canonical).digest("hex");
    }

    async getTopupIdempotencyRecord(operationHash: string): Promise<TopupIdempotencyRecord | null> {
        if (!this.docClient || !this.userOperationsTable) {
            return null;
        }

        const response = await this.docClient.send(
            new GetCommand({
                TableName: this.userOperationsTable,
                Key: { operationHash },
            })
        );

        const record = response.Item as TopupIdempotencyRecord | undefined;
        if (!record || record.requestType !== "TOPUP_IDEMPOTENCY") {
            return null;
        }

        return record;
    }

    async putTopupInProgress(input: {
        operationHash: string;
        walletAddress: string;
        chain: string;
        idempotencyKey: string;
    }): Promise<"stored" | "already_exists"> {
        if (!this.docClient || !this.userOperationsTable) {
            return "already_exists";
        }

        const now = new Date().toISOString();

        try {
            await this.docClient.send(
                new PutCommand({
                    TableName: this.userOperationsTable,
                    Item: {
                        operationHash: input.operationHash,
                        requestType: "TOPUP_IDEMPOTENCY",
                        walletAddress: input.walletAddress.toLowerCase(),
                        chain: input.chain,
                        idempotencyKey: input.idempotencyKey,
                        status: "IN_PROGRESS",
                        ttl: this.computeTtl(),
                        createdAt: now,
                        updatedAt: now,
                    },
                    ConditionExpression: "attribute_not_exists(operationHash)",
                })
            );
            return "stored";
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                return "already_exists";
            }
            throw error;
        }
    }

    async finalizeTopupIdempotency(input: {
        operationHash: string;
        status: Exclude<IdempotencyStatus, "IN_PROGRESS">;
        httpStatusCode: number;
        responsePayload?: Record<string, unknown>;
        errorPayload?: Record<string, unknown>;
    }): Promise<void> {
        if (!this.docClient || !this.userOperationsTable) {
            return;
        }

        const expressionValues: Record<string, unknown> = {
            ":status": input.status,
            ":httpStatusCode": input.httpStatusCode,
            ":updatedAt": new Date().toISOString(),
        };

        const expressionNames: Record<string, string> = {
            "#status": "status",
            "#httpStatusCode": "httpStatusCode",
            "#updatedAt": "updatedAt",
        };

        let updateExpression = "SET #status = :status, #httpStatusCode = :httpStatusCode, #updatedAt = :updatedAt";

        if (input.responsePayload) {
            updateExpression += ", #responsePayload = :responsePayload";
            expressionNames["#responsePayload"] = "responsePayload";
            expressionValues[":responsePayload"] = input.responsePayload;
        }

        if (input.errorPayload) {
            updateExpression += ", #errorPayload = :errorPayload";
            expressionNames["#errorPayload"] = "errorPayload";
            expressionValues[":errorPayload"] = input.errorPayload;
        }

        await this.docClient.send(
            new UpdateCommand({
                TableName: this.userOperationsTable,
                Key: { operationHash: input.operationHash },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: expressionNames,
                ExpressionAttributeValues: expressionValues,
            })
        );
    }

    async recordSwapBuild(record: SwapHistoryRecord, idempotencyKey?: string): Promise<string | null> {
        if (!this.docClient || !this.swapHistoryTable) {
            return null;
        }

        const canonical = JSON.stringify({
            chain: record.chain,
            tokenIn: record.tokenIn.toLowerCase(),
            tokenOut: record.tokenOut.toLowerCase(),
            amountIn: record.amountIn,
            minAmountOut: record.minAmountOut,
            to: record.to.toLowerCase(),
            idempotencyKey: idempotencyKey?.trim() || null,
        });
        const swapId = createHash("sha256").update(canonical).digest("hex");

        try {
            await this.docClient.send(
                new PutCommand({
                    TableName: this.swapHistoryTable,
                    Item: {
                        swapId,
                        ...record,
                        status: record.status ?? "BUILT",
                        ttl: record.ttl ?? this.computeTtl(),
                        createdAt: new Date().toISOString(),
                    },
                    ConditionExpression: "attribute_not_exists(swapId)",
                })
            );
        } catch (error) {
            if (!(error instanceof ConditionalCheckFailedException)) {
                throw error;
            }
        }

        return swapId;
    }

    async recordWalletActivation(walletAddress: string, record: WalletActivationRecord): Promise<void> {
        if (!this.docClient || !this.walletActivationsTable) {
            return;
        }

        await this.docClient.send(
            new UpdateCommand({
                TableName: this.walletActivationsTable,
                Key: { walletAddress: walletAddress.toLowerCase() },
                UpdateExpression:
                    "SET #chain = :chain, #lastTopupTx = :tx, #lastAmount = :amount, #updatedAt = :updatedAt, #status = :status, #activationTimestamp = if_not_exists(#activationTimestamp, :activationTimestamp)",
                ExpressionAttributeNames: {
                    "#chain": "chain",
                    "#lastTopupTx": "lastTopupTx",
                    "#lastAmount": "lastAmount",
                    "#updatedAt": "updatedAt",
                    "#status": "status",
                    "#activationTimestamp": "activationTimestamp",
                },
                ExpressionAttributeValues: {
                    ":chain": record.chain,
                    ":tx": record.transactionHash,
                    ":amount": record.amount,
                    ":updatedAt": new Date().toISOString(),
                    ":status": "ACTIVE",
                    ":activationTimestamp": Math.floor(Date.now() / 1000),
                },
            })
        );
    }

    async listRecentSwapBuilds(options?: {
        sinceIso?: string;
        limit?: number;
    }): Promise<SwapHistoryRecord[]> {
        if (!this.docClient || !this.swapHistoryTable) {
            return [];
        }

        try {
            const response = await this.docClient.send(
                new ScanCommand({
                    TableName: this.swapHistoryTable,
                    ...(options?.sinceIso
                        ? {
                            FilterExpression: "#createdAt >= :sinceIso",
                            ExpressionAttributeNames: { "#createdAt": "createdAt" },
                            ExpressionAttributeValues: { ":sinceIso": options.sinceIso },
                        }
                        : {}),
                    Limit: options?.limit ?? 500,
                })
            );

            const items = (response.Items ?? []) as SwapHistoryRecord[];
            return items.sort((a, b) => {
                const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
                const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
                return bTime - aTime;
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("not authorized to perform: dynamodb:Scan")) {
                console.warn("WARN: Swap dashboard scan is not permitted by IAM; returning empty dashboard dataset.");
                return [];
            }
            throw error;
        }
    }

    async recordAiTelemetry(input: {
        experimentId: string;
        variant: "control" | "treatment";
        endpoint: string;
        requestedChain: string;
        recommendedChain: string;
        measurableGain: boolean;
        estimatedGainBps: number;
        modelSource: string;
        chain: string;
        subjectKey: string;
    }): Promise<string | null> {
        if (!this.docClient || !this.aiTelemetryTable) {
            return null;
        }

        const createdAt = new Date().toISOString();
        const telemetryId = createHash("sha256")
            .update(
                JSON.stringify({
                    experimentId: input.experimentId,
                    variant: input.variant,
                    endpoint: input.endpoint,
                    requestedChain: input.requestedChain,
                    recommendedChain: input.recommendedChain,
                    measurableGain: input.measurableGain,
                    estimatedGainBps: input.estimatedGainBps,
                    modelSource: input.modelSource,
                    chain: input.chain,
                    subjectKey: input.subjectKey,
                    createdAt,
                })
            )
            .digest("hex");

        try {
            await this.docClient.send(
                new PutCommand({
                    TableName: this.aiTelemetryTable,
                    Item: {
                        telemetryId,
                        experimentId: input.experimentId,
                        variant: input.variant,
                        endpoint: input.endpoint,
                        requestedChain: input.requestedChain,
                        recommendedChain: input.recommendedChain,
                        measurableGain: input.measurableGain,
                        estimatedGainBps: input.estimatedGainBps,
                        modelSource: input.modelSource,
                        chain: input.chain,
                        createdAt,
                        ttl: this.computeTtl(),
                    },
                    ConditionExpression: "attribute_not_exists(telemetryId)",
                })
            );
            return telemetryId;
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                return telemetryId;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("not authorized to perform")) {
                console.warn("WARN: AI telemetry write is not permitted by IAM; skipping telemetry persistence.");
                return null;
            }
            throw error;
        }
    }

    async listRecentAiTelemetry(options?: {
        sinceIso?: string;
        limit?: number;
    }): Promise<AiTelemetryRecord[]> {
        if (!this.docClient || !this.aiTelemetryTable) {
            return [];
        }

        try {
            const response = await this.docClient.send(
                new ScanCommand({
                    TableName: this.aiTelemetryTable,
                    ...(options?.sinceIso
                        ? {
                            FilterExpression: "#createdAt >= :sinceIso",
                            ExpressionAttributeNames: { "#createdAt": "createdAt" },
                            ExpressionAttributeValues: { ":sinceIso": options.sinceIso },
                        }
                        : {}),
                    Limit: options?.limit ?? 1000,
                })
            );

            const items = (response.Items ?? []) as AiTelemetryRecord[];
            return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("not authorized to perform: dynamodb:Scan")) {
                console.warn("WARN: AI telemetry scan is not permitted by IAM; returning empty telemetry dataset.");
                return [];
            }
            throw error;
        }
    }
}
