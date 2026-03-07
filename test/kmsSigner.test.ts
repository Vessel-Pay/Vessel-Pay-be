import { beforeEach, describe, expect, it, vi } from "vitest";
import { KmsSignerService } from "../src/services/kmsSigner.js";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-kms", () => ({
    KMSClient: vi.fn().mockImplementation(() => ({
        send: sendMock,
    })),
    SignCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

describe("KmsSignerService malformed signature handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const createService = () =>
        new KmsSignerService({
            kmsKeyId: "test-kms-key-id",
            signerAddress: "0x2222222222222222222222222222222222222222",
            region: "us-east-1",
        });

    const buildParams = () => ({
        payerAddress: "0x3333333333333333333333333333333333333333" as const,
        tokenAddress: "0x4444444444444444444444444444444444444444" as const,
        validUntil: Math.floor(Date.now() / 1000) + 3600,
        validAfter: 0,
        isActivation: false,
    });

    it("rejects invalid validity window before KMS call", async () => {
        const service = createService();

        await expect(
            service.signPaymasterData({
                ...buildParams(),
                validUntil: 100,
                validAfter: 101,
            })
        ).rejects.toThrow("invalid_validity_window");

        expect(sendMock).not.toHaveBeenCalled();
    });

    it("fails when KMS returns empty signature", async () => {
        sendMock.mockResolvedValue({ Signature: undefined });

        const service = createService();

        await expect(service.signPaymasterData(buildParams())).rejects.toThrow(
            "kms_sign_failed: empty signature"
        );
    });

    it("fails on too-short DER signatures", async () => {
        sendMock.mockResolvedValue({ Signature: new Uint8Array([0x30, 0x03, 0x02]) });

        const service = createService();

        await expect(service.signPaymasterData(buildParams())).rejects.toThrow(
            "invalid_der_signature: too short"
        );
    });

    it("fails on malformed DER sequence prefix", async () => {
        sendMock.mockResolvedValue({
            Signature: new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
        });

        const service = createService();

        await expect(service.signPaymasterData(buildParams())).rejects.toThrow(
            "invalid_der_signature: expected sequence"
        );
    });

    it("fails when KMS rejects signing due to permission boundary", async () => {
        sendMock.mockRejectedValue(new Error("AccessDeniedException: not authorized to perform kms:Sign"));

        const service = createService();

        await expect(service.signPaymasterData(buildParams())).rejects.toThrow(
            "AccessDeniedException"
        );
    });
});
