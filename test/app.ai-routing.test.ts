import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const signPaymasterDataMock = vi.fn();
const getUserOperationMock = vi.fn();
const putUserOperationMock = vi.fn();
const recordSwapBuildMock = vi.fn();

const getRoutingAdvisoryMock = vi.fn();

vi.mock("viem", async () => {
    const actual = await vi.importActual<typeof import("viem")>("viem");
    return {
        ...actual,
        createPublicClient: vi.fn().mockImplementation(() => ({
            readContract: vi.fn().mockResolvedValue([1000n, 10n, 1010n]),
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

vi.mock("../src/services/aiRouter.js", () => ({
    getRoutingAdvisory: getRoutingAdvisoryMock,
}));

process.env.RPC_URL = "https://example-rpc.local";
process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.KMS_KEY_ID = "kms-key-id";
process.env.PAYMASTER_SIGNER_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.SIGN_RATE_LIMIT_PER_MINUTE = "100";
process.env.TOPUP_RATE_LIMIT_PER_MINUTE = "100";

// Intentionally keep Etherlink unset so deterministic quote set is incomplete.
delete process.env.RPC_URL_ETHERLINK;
delete process.env.STABLE_SWAP_ADDRESS_ETHERLINK;

let app: import("express").Express;

describe("AI routing guardrails in /swap/build", () => {
    beforeAll(async () => {
        ({ app } = await import("../src/app.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        recordSwapBuildMock.mockResolvedValue("swap-id-1");
    });

    it("keeps requested chain when AI guardrails fail", async () => {
        getRoutingAdvisoryMock.mockResolvedValue({
            enabled: true,
            source: "bedrock",
            selectedChain: "etherlink_shadownet",
            confidence: 0.81,
            reason: "recommended but blocked",
            guardrailsPassed: false,
            rejectedReason: "chain_not_allowlisted",
            estimatedFeeBps: 80,
        });

        const response = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "900",
                autoRoute: true,
            });

        expect(response.status).toBe(200);
        expect(response.body.chain).toBe("base_sepolia");
        expect(response.body.autoRouteApplied).toBe(false);
        expect(response.body.aiAdvisory.guardrailsPassed).toBe(false);
    });

    it("rejects auto-route when deterministic quote verification fails", async () => {
        getRoutingAdvisoryMock.mockResolvedValue({
            enabled: true,
            source: "bedrock",
            selectedChain: "etherlink_shadownet",
            confidence: 0.92,
            reason: "prefer etherlink",
            guardrailsPassed: true,
            estimatedFeeBps: 70,
        });

        const response = await request(app)
            .post("/swap/build?chain=base")
            .send({
                tokenIn: "0x3333333333333333333333333333333333333333",
                tokenOut: "0x4444444444444444444444444444444444444444",
                amountIn: "1000",
                minAmountOut: "999999999",
                autoRoute: true,
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe("build_failed");
        expect(response.body.message).toContain("minAmountOut exceeds deterministic on-chain quote");
        expect(recordSwapBuildMock).not.toHaveBeenCalled();
    });
});
