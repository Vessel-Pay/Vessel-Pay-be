import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/kmsSigner.js", () => ({
    KmsSignerService: vi.fn().mockImplementation(() => ({
        signPaymasterData: vi.fn().mockResolvedValue("0xsignature"),
    })),
}));

vi.mock("../src/services/persistence.js", () => ({
    PersistenceService: vi.fn().mockImplementation(() => ({
        isEnabled: () => true,
        buildOperationHash: () => "op-hash-1",
        getUserOperation: vi.fn().mockResolvedValue(null),
        putUserOperation: vi.fn().mockResolvedValue("stored"),
        recordSwapBuild: vi.fn(),
        recordWalletActivation: vi.fn(),
        buildTopupOperationHash: vi.fn(),
        getTopupIdempotencyRecord: vi.fn(),
        putTopupInProgress: vi.fn(),
        finalizeTopupIdempotency: vi.fn(),
        recordAiTelemetry: vi.fn(),
        listRecentSwapBuilds: vi.fn().mockResolvedValue([]),
        listRecentAiTelemetry: vi.fn().mockResolvedValue([]),
    })),
}));

describe("Fail-closed auth when API keys missing", () => {
    const prevSign = process.env.EDGE_SIGN_API_KEY;
    const prevTopup = process.env.EDGE_TOPUP_API_KEY;
    const prevLegacy = process.env.EDGE_API_KEY;
    const prevFailClosed = process.env.FAIL_CLOSED_API_KEYS;

    afterAll(() => {
        process.env.EDGE_SIGN_API_KEY = prevSign;
        process.env.EDGE_TOPUP_API_KEY = prevTopup;
        process.env.EDGE_API_KEY = prevLegacy;
        process.env.FAIL_CLOSED_API_KEYS = prevFailClosed;
    });

    it("returns 503 on /sign when edge sign key is unconfigured", async () => {
        process.env.RPC_URL = "https://base-rpc.local";
        process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
        process.env.KMS_KEY_ID = "kms-key-id";
        process.env.PAYMASTER_SIGNER_ADDRESS = "0x2222222222222222222222222222222222222222";
        process.env.FAIL_CLOSED_API_KEYS = "true";
        delete process.env.EDGE_SIGN_API_KEY;
        delete process.env.EDGE_API_KEY;

        vi.resetModules();
        const { app } = await import("../src/app.js");

        const response = await request(app)
            .post("/sign")
            .send({
                payerAddress: "0x3333333333333333333333333333333333333333",
                tokenAddress: "0x4444444444444444444444444444444444444444",
                validUntil: Math.floor(Date.now() / 1000) + 3600,
                validAfter: 0,
                isActivation: false,
            });

        expect(response.status).toBe(503);
        expect(response.body.error).toBe("service_unavailable");
    });
});
