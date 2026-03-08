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

process.env.RPC_URL = "https://base-rpc.local";
process.env.RPC_URL_ETHERLINK = "https://etherlink-rpc.local";
process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.STABLE_SWAP_ADDRESS_ETHERLINK = "0x2222222222222222222222222222222222222222";
process.env.KMS_KEY_ID = "kms-key-id";
process.env.PAYMASTER_SIGNER_ADDRESS = "0x9999999999999999999999999999999999999999";
process.env.EDGE_TOPUP_API_KEY = "test-topup-key";
process.env.SIGN_RATE_LIMIT_PER_MINUTE = "100";
process.env.TOPUP_RATE_LIMIT_PER_MINUTE = "1";

let app: import("express").Express;

describe("Reliability suite: throttling, retry, RPC outage", () => {
    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        readContractMock.mockResolvedValue([1000n, 10n, 1010n]);

        recordSwapBuildMock.mockResolvedValue("swap-id-1");
        buildTopupOperationHashMock.mockReturnValue("topup-op-hash-1");
        getTopupIdempotencyRecordMock.mockResolvedValue(null);
        putTopupInProgressMock.mockResolvedValue("stored");
        finalizeTopupIdempotencyMock.mockResolvedValue(undefined);
    });

    it("returns retry-after header on topup throttling", async () => {
        const first = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.10.0.1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        const second = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.10.0.1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(first.status).toBe(400);
        expect(second.status).toBe(429);
        expect(second.body.error).toBe("rate_limit_exceeded");
        expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("supports retrying topup idempotency after in-progress response", async () => {
        getTopupIdempotencyRecordMock
            .mockResolvedValueOnce({ status: "IN_PROGRESS" })
            .mockResolvedValueOnce({
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

        const first = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.10.0.2")
            .set("idempotency-key", "retry-idem-key")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        const second = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.10.0.3")
            .set("idempotency-key", "retry-idem-key")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(first.status).toBe(409);
        expect(first.body.error).toBe("idempotency_in_progress");
        expect(second.status).toBe(200);
        expect(second.body.replayed).toBe(true);
        expect(second.body.transactionHash).toBe("0xabc");
    });

    it("returns quote_failed when selected chain RPC is unavailable", async () => {
        readContractMock.mockImplementation(async (params: { address: string }) => {
            if (params.address.toLowerCase() === "0x1111111111111111111111111111111111111111") {
                throw new Error("rpc timeout");
            }
            return [1000n, 10n, 1010n] as const;
        });

        const response = await request(app)
            .get("/swap/quote")
            .query({
                chain: "base",
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("quote_failed");
        expect(response.body.message).toContain("rpc timeout");
    });

    it("auto-routes to healthy chain when requested chain RPC is unavailable", async () => {
        readContractMock.mockImplementation(async (params: { address: string }) => {
            if (params.address.toLowerCase() === "0x1111111111111111111111111111111111111111") {
                throw new Error("base rpc down");
            }
            if (params.address.toLowerCase() === "0x2222222222222222222222222222222222222222") {
                return [1500n, 15n, 1515n] as const;
            }
            throw new Error("unexpected address");
        });

        getRoutingAdvisoryMock.mockResolvedValue({
            enabled: true,
            source: "bedrock",
            selectedChain: "etherlink_shadownet",
            confidence: 0.9,
            reason: "etherlink quote available",
            guardrailsPassed: true,
            estimatedFeeBps: 90,
        });

        const response = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "1200",
                autoRoute: true,
            });

        expect(response.status).toBe(200);
        expect(response.body.chain).toBe("etherlink_shadownet");
        expect(response.body.autoRouteApplied).toBe(true);
    });
});
