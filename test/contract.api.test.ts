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
process.env.SIGN_RATE_LIMIT_PER_MINUTE = "100";
process.env.TOPUP_RATE_LIMIT_PER_MINUTE = "100";
delete process.env.EDGE_SIGN_API_KEY;
delete process.env.EDGE_TOPUP_API_KEY;

delete process.env.FAUCET_SIGNER_PRIVATE_KEY;
delete process.env.FAUCET_SIGNER_SECRET_ARN;

let app: import("express").Express;

describe("API contract compatibility", () => {
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
        getUserOperationMock.mockResolvedValue(null);
        signPaymasterDataMock.mockResolvedValue("0xsignature123");
    });

    it("keeps GET /health response shape", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(response.body).toHaveProperty("signerAddress");
        expect(response.body).toHaveProperty("message");
        expect(response.body).toHaveProperty("defaultChain");
        expect(response.body).toHaveProperty("chains");
        expect(Array.isArray(response.body.chains)).toBe(true);
    });

    it("keeps GET /signer response shape", async () => {
        const response = await request(app).get("/signer");

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("signerAddress");
        expect(response.body).toHaveProperty("note");
    });

    it("keeps POST /sign response shape", async () => {
        const response = await request(app)
            .post("/sign?chain=base")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: Math.floor(Date.now() / 1000) + 3600,
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("signature");
        expect(response.body).toHaveProperty("operationHash");
    });

    it("keeps GET /swap/quote error contract", async () => {
        const response = await request(app)
            .get("/swap/quote?chain=base")
            .query({
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
            });

        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty("error");
        expect(response.body).toHaveProperty("message");
    });

    it("keeps POST /swap/build response shape", async () => {
        const response = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "900",
            });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("to");
        expect(response.body).toHaveProperty("data");
        expect(response.body).toHaveProperty("value");
    });

    it("keeps POST /topup-idrx validation error contract", async () => {
        const response = await request(app)
            .post("/topup-idrx")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty("error");
        expect(response.body).toHaveProperty("message");
    });
});
