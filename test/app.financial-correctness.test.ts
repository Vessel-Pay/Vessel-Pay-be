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
process.env.EDGE_SIGN_API_KEY = "test-sign-key";
process.env.EDGE_TOPUP_API_KEY = "test-topup-key";
process.env.SIGN_RATE_LIMIT_PER_MINUTE = "100";
process.env.TOPUP_RATE_LIMIT_PER_MINUTE = "100";

let app: import("express").Express;

describe("Financial correctness: idempotency, duplicates, quote/build consistency", () => {
    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();

        signPaymasterDataMock.mockResolvedValue("0xsignature123");
        putUserOperationMock.mockResolvedValue("stored");

        recordSwapBuildMock.mockResolvedValue("swap-id-1");
        buildTopupOperationHashMock.mockReturnValue("topup-op-hash-1");
        getTopupIdempotencyRecordMock.mockResolvedValue(null);
        putTopupInProgressMock.mockResolvedValue("stored");
        finalizeTopupIdempotencyMock.mockResolvedValue(undefined);

        readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
            if (functionName === "reserves") {
                return 5000n;
            }
            return [1200n, 12n, 1212n];
        });
        getRoutingAdvisoryMock.mockResolvedValue({
            enabled: true,
            source: "bedrock",
            selectedChain: "base_sepolia",
            confidence: 0.92,
            reason: "best deterministic quote",
            guardrailsPassed: true,
            estimatedFeeBps: 75,
        });
    });

    it("re-signs duplicate /sign payload when persisted signature is stale", async () => {
        getUserOperationMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ signature: "0xsignature123" });

        const payload = {
            payerAddress: "0x3333333333333333333333333333333333333333",
            tokenAddress: "0x4444444444444444444444444444444444444444",
            validUntil: Math.floor(Date.now() / 1000) + 3600,
            validAfter: 0,
            isActivation: false,
            chain: "base",
        };

        const first = await request(app)
            .post("/sign")
            .set("x-api-key", "test-sign-key")
            .send(payload);

        const duplicate = await request(app)
            .post("/sign")
            .set("x-api-key", "test-sign-key")
            .send(payload);

        expect(first.status).toBe(200);
        expect(duplicate.status).toBe(200);
        expect(first.body.signature).toBe(duplicate.body.signature);
        expect(duplicate.body.replayed).toBeUndefined();
        expect(signPaymasterDataMock).toHaveBeenCalledTimes(2);
    });

    it("returns 409 for duplicate topup submission race on idempotency insert", async () => {
        putTopupInProgressMock.mockResolvedValue("already_exists");

        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("idempotency-key", "same-key")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(409);
        expect(response.body.error).toBe("idempotency_in_progress");
        expect(finalizeTopupIdempotencyMock).not.toHaveBeenCalled();
    });

    it("keeps /swap/quote and /swap/build auto-route consistency", async () => {
        const quote = await request(app)
            .get("/swap/quote")
            .query({
                chain: "base",
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
            });

        expect(quote.status).toBe(200);
        expect(quote.body.amountOut).toBe("1200");

        const buildOk = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: quote.body.amountOut,
                autoRoute: true,
            });

        expect(buildOk.status).toBe(200);
        expect(buildOk.body.chain).toBe("base_sepolia");

        const buildTooHigh = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "1300",
                autoRoute: true,
            });

        expect(buildTooHigh.status).toBe(400);
        expect(buildTooHigh.body.error).toBe("build_failed");
        expect(String(buildTooHigh.body.message)).toContain("minAmountOut exceeds deterministic on-chain quote");
    });
});
