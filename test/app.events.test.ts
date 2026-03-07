import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const signPaymasterDataMock = vi.fn();
const getUserOperationMock = vi.fn();
const putUserOperationMock = vi.fn();
const recordSwapBuildMock = vi.fn();
const buildTopupOperationHashMock = vi.fn();
const getTopupIdempotencyRecordMock = vi.fn();
const putTopupInProgressMock = vi.fn();
const finalizeTopupIdempotencyMock = vi.fn();

const publishSwapCompletedMock = vi.fn();
const publishTransactionFailedMock = vi.fn();
const publishWalletActivatedMock = vi.fn();

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
        recordWalletActivation: vi.fn(),
        buildTopupOperationHash: buildTopupOperationHashMock,
        getTopupIdempotencyRecord: getTopupIdempotencyRecordMock,
        putTopupInProgress: putTopupInProgressMock,
        finalizeTopupIdempotency: finalizeTopupIdempotencyMock,
    })),
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
process.env.TOPUP_RATE_LIMIT_PER_MINUTE = "100";

let app: import("express").Express;

describe("SNS domain event publishing", () => {
    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();

        recordSwapBuildMock.mockResolvedValue("swap-id-1");
        buildTopupOperationHashMock.mockReturnValue("topup-op-hash-1");
        getTopupIdempotencyRecordMock.mockResolvedValue(null);
        putTopupInProgressMock.mockResolvedValue("stored");
        finalizeTopupIdempotencyMock.mockResolvedValue(undefined);
        publishSwapCompletedMock.mockResolvedValue({ published: true, messageId: "msg-1" });
        publishTransactionFailedMock.mockResolvedValue({ published: true, messageId: "msg-2" });
        publishWalletActivatedMock.mockResolvedValue({ published: true, messageId: "msg-3" });
    });

    it("publishes swapCompleted event on /swap/build success", async () => {
        const response = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "900",
            });

        expect(response.status).toBe(200);
        expect(publishSwapCompletedMock).toHaveBeenCalledTimes(1);
        expect(publishSwapCompletedMock).toHaveBeenCalledWith(
            expect.objectContaining({
                chain: "base_sepolia",
                chainId: 84532,
                amountIn: "1000",
                minAmountOut: "900",
            })
        );
        expect(publishTransactionFailedMock).not.toHaveBeenCalled();
    });

    it("publishes transactionFailed event on /topup-idrx failure", async () => {
        const response = await request(app)
            .post("/topup-idrx")
            .set("x-api-key", "test-topup-key")
            .set("x-forwarded-for", "10.1.0.11")
            .set("idempotency-key", "topup-key-1")
            .send({
                walletAddress: "0x3333333333333333333333333333333333333333",
                amount: "100",
                chain: "base",
            });

        expect(response.status).toBe(500);
        expect(response.body.error).toBe("faucet_signer_not_configured");
        expect(publishTransactionFailedMock).toHaveBeenCalledTimes(1);
        expect(publishTransactionFailedMock).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: "/topup-idrx",
                chain: "base_sepolia",
                chainId: 84532,
            })
        );
    });
});
