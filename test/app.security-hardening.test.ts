import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getUserOperationMock = vi.fn();
const putUserOperationMock = vi.fn();

vi.mock("../src/services/kmsSigner.js", () => ({
    KmsSignerService: vi.fn().mockImplementation(() => ({
        signPaymasterData: vi.fn().mockResolvedValue("0xsignature"),
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
        buildTopupOperationHash: vi.fn(),
        getTopupIdempotencyRecord: vi.fn(),
        putTopupInProgress: vi.fn(),
        finalizeTopupIdempotency: vi.fn(),
        recordAiTelemetry: vi.fn(),
        listRecentSwapBuilds: vi.fn().mockResolvedValue([]),
        listRecentAiTelemetry: vi.fn().mockResolvedValue([]),
    })),
}));

process.env.RPC_URL = "https://base-rpc.local";
process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.KMS_KEY_ID = "kms-key-id";
process.env.PAYMASTER_SIGNER_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.EDGE_SIGN_API_KEY = "test-sign-key";
process.env.AI_RATE_LIMIT_PER_MINUTE = "1";
process.env.SIGN_RATE_LIMIT_PER_MINUTE = "10";

let app: import("express").Express;

describe("Security hardening regression", () => {
    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        getUserOperationMock.mockResolvedValue(null);
        putUserOperationMock.mockResolvedValue("stored");
    });

    it("redacts low-level AgentCore errors in fallbackReason", async () => {
        const response = await request(app)
            .post("/ai/agentcore/session")
            .set("x-forwarded-for", "10.30.0.1")
            .send({ inputText: "Summarize risk posture" });

        expect(response.status).toBe(200);
        expect(response.body.provider).toBe("bedrock-agentcore-fallback");
        expect(typeof response.body.fallbackReason).toBe("string");
        expect(String(response.body.fallbackReason).toLowerCase()).not.toContain("deserialization");
        expect(String(response.body.fallbackReason).toLowerCase()).not.toContain("$response");
    });

    it("rate limits AI endpoints by client", async () => {
        const first = await request(app)
            .post("/ai/copilot")
            .set("x-forwarded-for", "10.30.0.2")
            .send({ prompt: "help me" });

        const second = await request(app)
            .post("/ai/copilot")
            .set("x-forwarded-for", "10.30.0.2")
            .send({ prompt: "help me again" });

        expect(first.status).toBe(200);
        expect(second.status).toBe(429);
        expect(second.body.error).toBe("rate_limit_exceeded");
    });
});
