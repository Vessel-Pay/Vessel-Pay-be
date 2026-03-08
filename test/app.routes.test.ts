import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const signPaymasterDataMock = vi.fn();
const getUserOperationMock = vi.fn();
const putUserOperationMock = vi.fn();
const recordSwapBuildMock = vi.fn();
const recordWalletActivationMock = vi.fn();
const buildTopupOperationHashMock = vi.fn();
const getTopupIdempotencyRecordMock = vi.fn();
const putTopupInProgressMock = vi.fn();
const finalizeTopupIdempotencyMock = vi.fn();
const readContractMock = vi.fn();
const getRoutingAdvisoryMock = vi.fn();
const publishSwapCompletedMock = vi.fn();
const publishTransactionFailedMock = vi.fn();
const publishWalletActivatedMock = vi.fn();

vi.mock("viem", async () => {
    const actual = await vi.importActual<typeof import("viem")>("viem");
    return {
        ...actual,
        createPublicClient: vi.fn().mockImplementation(() => ({
            readContract: readContractMock,
            getBytecode: vi.fn().mockResolvedValue("0x"),
            waitForTransactionReceipt: vi.fn().mockResolvedValue({ blockNumber: 1n }),
        })),
        http: vi.fn().mockReturnValue({}),
    };
});

vi.mock("../src/services/kmsSigner.js", () => ({
    KmsSignerService: vi.fn().mockImplementation(() => ({
        signPaymasterData: signPaymasterDataMock,
    })),
}));

vi.mock("../src/services/persistence.js", () => ({
    PersistenceService: vi.fn().mockImplementation(() => ({
        isEnabled: () => true,
        buildOperationHash: () => "op-hash-1",
        getUserOperation: getUserOperationMock,
        putUserOperation: putUserOperationMock,
        recordSwapBuild: recordSwapBuildMock,
        recordWalletActivation: recordWalletActivationMock,
        buildTopupOperationHash: buildTopupOperationHashMock,
        getTopupIdempotencyRecord: getTopupIdempotencyRecordMock,
        putTopupInProgress: putTopupInProgressMock,
        finalizeTopupIdempotency: finalizeTopupIdempotencyMock,
        recordAiTelemetry: vi.fn(),
        listRecentSwapBuilds: vi.fn().mockResolvedValue([]),
        listRecentAiTelemetry: vi.fn().mockResolvedValue([]),
    })),
}));

vi.mock("../src/services/aiRouter.js", () => ({
    getRoutingAdvisory: getRoutingAdvisoryMock,
}));

vi.mock("../src/services/eventPublisher.js", () => ({
    publishSwapCompleted: publishSwapCompletedMock,
    publishTransactionFailed: publishTransactionFailedMock,
    publishWalletActivated: publishWalletActivatedMock,
}));

process.env.RPC_URL = "https://example-rpc.local";
process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.KMS_KEY_ID = "kms-key-id";
process.env.PAYMASTER_SIGNER_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.EDGE_TOPUP_API_KEY = "test-topup-key";
process.env.TOPUP_RATE_LIMIT_PER_MINUTE = "1";
delete process.env.FAUCET_SIGNER_PRIVATE_KEY;
delete process.env.FAUCET_SIGNER_SECRET_ARN;

let app: import("express").Express;

describe("Request context and logging headers", () => {
    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
            if (functionName === "reserves") {
                return 5000n;
            }
            return [1200n, 12n, 1212n];
        });
        getRoutingAdvisoryMock.mockResolvedValue({
            enabled: true,
            selectedChain: "base_sepolia",
            guardrailsPassed: true,
        });
        publishSwapCompletedMock.mockResolvedValue({ published: false, reason: "disabled" });
        publishTransactionFailedMock.mockResolvedValue({ published: false, reason: "disabled" });
        publishWalletActivatedMock.mockResolvedValue({ published: false, reason: "disabled" });
        recordSwapBuildMock.mockResolvedValue("swap-id-1");
        buildTopupOperationHashMock.mockReturnValue("topup-op-hash-1");
        getTopupIdempotencyRecordMock.mockResolvedValue(null);
        putTopupInProgressMock.mockResolvedValue("stored");
        finalizeTopupIdempotencyMock.mockResolvedValue(undefined);
    });

    it("returns generated x-request-id on /swap/build", async () => {
        const response = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "900",
            });

        expect(response.status).toBe(200);
        expect(typeof response.headers["x-request-id"]).toBe("string");
        expect(response.headers["x-request-id"].length).toBeGreaterThan(0);
        expect(response.body.to).toBe("0x1111111111111111111111111111111111111111");
    });

    it("preserves inbound x-request-id on /swap/build", async () => {
        const requestId = "req-swap-build-123";

        const response = await request(app)
            .post("/swap/build?chain=base")
            .set("x-request-id", requestId)
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "900",
            });

        expect(response.status).toBe(200);
        expect(response.headers["x-request-id"]).toBe(requestId);
    });

    it("returns generated x-request-id on /swap/quote validation failure", async () => {
        const response = await request(app)
            .get("/swap/quote?chain=base")
            .query({
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("quote_failed");
        expect(typeof response.headers["x-request-id"]).toBe("string");
        expect(response.headers["x-request-id"].length).toBeGreaterThan(0);
    });

    it("preserves inbound x-request-id on /swap/quote validation failure", async () => {
        const requestId = "req-swap-quote-123";

        const response = await request(app)
            .get("/swap/quote?chain=base")
            .set("x-request-id", requestId)
            .query({
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("quote_failed");
        expect(response.headers["x-request-id"]).toBe(requestId);
    });

    it("returns x-request-id on /topup-idrx failure when faucet signer is missing", async () => {
        const requestId = "req-topup-456";

        const response = await request(app)
            .post("/topup-idrx")
            .set("x-request-id", requestId)
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.1")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(500);
        expect(response.headers["x-request-id"]).toBe(requestId);
        expect(response.body.error).toBe("faucet_signer_not_configured");
        expect(putTopupInProgressMock).toHaveBeenCalledTimes(1);
        expect(finalizeTopupIdempotencyMock).toHaveBeenCalledTimes(1);
    });

    it("requires Idempotency-Key header on /topup-idrx", async () => {
        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.2")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("invalid_idempotency_key");
        expect(putTopupInProgressMock).not.toHaveBeenCalled();
    });

    it("replays completed topup result for duplicate idempotency key", async () => {
        getTopupIdempotencyRecordMock.mockResolvedValue({
            status: "SUCCEEDED",
            httpStatusCode: 200,
            responsePayload: {
                success: true,
                transactionHash: "0xabc",
                amount: "100",
                recipient: "0x3333333333333333333333333333333333333333",
                chain: "base_sepolia",
                chainId: 84532,
            },
        });

        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.3")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(200);
        expect(response.body.replayed).toBe(true);
        expect(response.body.transactionHash).toBe("0xabc");
        expect(putTopupInProgressMock).not.toHaveBeenCalled();
    });

    it("returns 409 when duplicate idempotency key is in progress", async () => {
        getTopupIdempotencyRecordMock.mockResolvedValue({
            status: "IN_PROGRESS",
        });

        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.4")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe("idempotency_in_progress");
        expect(putTopupInProgressMock).not.toHaveBeenCalled();
    });

    it("replays failed topup result for duplicate idempotency key", async () => {
        getTopupIdempotencyRecordMock.mockResolvedValue({
            status: "FAILED",
            httpStatusCode: 500,
            errorPayload: {
                error: "mint_failed",
                message: "Mint failed",
            },
        });

        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.5")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(500);
        expect(response.body.error).toBe("mint_failed");
        expect(response.body.replayed).toBe(true);
        expect(putTopupInProgressMock).not.toHaveBeenCalled();
    });

    it("rejects /topup-idrx when API key is missing", async () => {
        const response = await request(app)
            .post("/topup-idrx")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("unauthorized");
        expect(putTopupInProgressMock).not.toHaveBeenCalled();
    });

    it("rejects /topup-idrx when API key is invalid", async () => {
        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "wrong-topup-key")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("unauthorized");
        expect(putTopupInProgressMock).not.toHaveBeenCalled();
    });

    it("rate limits /topup-idrx with 429 after limit is reached", async () => {
        const first = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.9")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        const second = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.9")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(first.status).toBe(400);
        expect(second.status).toBe(429);
        expect(second.body.error).toBe("rate_limit_exceeded");
    });
});
