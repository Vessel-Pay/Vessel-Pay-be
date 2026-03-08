import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const signPaymasterDataMock = vi.fn();
const getUserOperationMock = vi.fn();
const putUserOperationMock = vi.fn();

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
        recordSwapBuild: vi.fn(),
        recordWalletActivation: vi.fn(),
        recordAiTelemetry: vi.fn(),
        listRecentSwapBuilds: vi.fn().mockResolvedValue([]),
        listRecentAiTelemetry: vi.fn().mockResolvedValue([]),
    })),
}));

process.env.RPC_URL = "https://example-rpc.local";
process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.KMS_KEY_ID = "kms-key-id";
process.env.PAYMASTER_SIGNER_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.EDGE_SIGN_API_KEY = "test-sign-key";
process.env.SIGN_RATE_LIMIT_PER_MINUTE = "1";

let app: import("express").Express;

describe("POST /sign", () => {
    const validUntil = () => Math.floor(Date.now() / 1000) + 3600;

    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        signPaymasterDataMock.mockResolvedValue("0xnew-signature");
        putUserOperationMock.mockResolvedValue("stored");
    });

    it("falls back to fresh signature when persisted replay signature is stale", async () => {
        getUserOperationMock.mockResolvedValue({ signature: "0xreplay-signature" });

        const response = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "test-sign-key")
            .set("x-forwarded-for", "10.0.0.1")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: validUntil(),
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            signature: "0xnew-signature",
            operationHash: "op-hash-1",
        });
        expect(signPaymasterDataMock).toHaveBeenCalledTimes(1);
        expect(putUserOperationMock).toHaveBeenCalledTimes(1);
    });

    it("still returns signature when persistence write fails", async () => {
        getUserOperationMock.mockResolvedValue(null);
        signPaymasterDataMock.mockResolvedValue("0xnew-signature");
        putUserOperationMock.mockRejectedValue(new Error("dynamodb unavailable"));

        const response = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "test-sign-key")
            .set("x-forwarded-for", "10.0.0.2")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: validUntil(),
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            signature: "0xnew-signature",
            operationHash: "op-hash-1",
        });
        expect(signPaymasterDataMock).toHaveBeenCalledTimes(1);
        expect(putUserOperationMock).toHaveBeenCalledTimes(1);
    });

    it("rejects stale validUntil timestamps", async () => {
        getUserOperationMock.mockResolvedValue(null);

        const response = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "test-sign-key")
            .set("x-forwarded-for", "10.0.0.3")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: 1,
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("signature_expired");
        expect(signPaymasterDataMock).not.toHaveBeenCalled();
    });

    it("rejects validUntil beyond max horizon", async () => {
        getUserOperationMock.mockResolvedValue(null);

        const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 48;
        const response = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "test-sign-key")
            .set("x-forwarded-for", "10.0.0.4")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: farFuture,
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("validity_horizon_exceeded");
        expect(signPaymasterDataMock).not.toHaveBeenCalled();
    });

    it("rejects /sign when API key is missing", async () => {
        const response = await request(app)
            .post("/sign?chain=base")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: validUntil(),
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("unauthorized");
        expect(signPaymasterDataMock).not.toHaveBeenCalled();
    });

    it("rejects /sign when API key is invalid", async () => {
        const response = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "wrong-sign-key")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: validUntil(),
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("unauthorized");
        expect(signPaymasterDataMock).not.toHaveBeenCalled();
    });

    it("rate limits /sign with 429 after limit is reached", async () => {
        const first = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "test-sign-key")
            .set("x-forwarded-for", "10.0.0.9")
            .send({});

        const second = await request(app)
            .post("/sign?chain=base")
            .set("x-api-key", "test-sign-key")
            .set("x-forwarded-for", "10.0.0.9")
            .send({});

        expect(first.status).toBe(400);
        expect(second.status).toBe(429);
        expect(second.body.error).toBe("rate_limit_exceeded");
    });
});
