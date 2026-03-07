import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
    encodePacked,
    encodeAbiParameters,
    getAddress,
    keccak256,
    parseAbiParameters,
    recoverAddress,
    type Address,
    type Hex,
} from "viem";

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;

type KmsSignerConfig = {
    kmsKeyId: string;
    signerAddress: Address;
    region?: string;
};

type PaymasterSignParams = {
    payerAddress: Address;
    tokenAddress: Address;
    validUntil: number;
    validAfter: number;
    isActivation: boolean;
};

export class KmsSignerService {
    private readonly kmsClient: KMSClient;
    private readonly kmsKeyId: string;
    private readonly signerAddress: Address;

    constructor(config: KmsSignerConfig) {
        this.kmsClient = new KMSClient({ region: config.region });
        this.kmsKeyId = config.kmsKeyId;
        this.signerAddress = getAddress(config.signerAddress);
    }

    async signPaymasterData(params: PaymasterSignParams): Promise<Hex> {
        const digest = this.computeDigest(params);
        const signingDigest = this.computeEthSignedDigest(digest);

        const signResponse = await this.kmsClient.send(
            new SignCommand({
                KeyId: this.kmsKeyId,
                Message: hexToBytes(signingDigest),
                MessageType: "DIGEST",
                SigningAlgorithm: "ECDSA_SHA_256",
            })
        );

        if (!signResponse.Signature) {
            throw new Error("kms_sign_failed: empty signature");
        }

        const parsed = parseDerSignature(signResponse.Signature);
        const normalizedS = parsed.s > SECP256K1_HALF_N ? SECP256K1_N - parsed.s : parsed.s;

        const rHex = toPadded32Hex(parsed.r);
        const sHex = toPadded32Hex(normalizedS);

        for (const v of [27, 28] as const) {
            const signature = buildSignatureHex(rHex, sHex, v);
            const recovered = await recoverAddress({ hash: signingDigest, signature });
            if (recovered.toLowerCase() === this.signerAddress.toLowerCase()) {
                return signature;
            }
        }

        throw new Error("kms_sign_failed: unable to recover expected signer address");
    }

    private computeDigest(params: PaymasterSignParams): Hex {
        const { payerAddress, tokenAddress, validUntil, validAfter, isActivation } = params;

        if (validAfter > validUntil) {
            throw new Error("invalid_validity_window: validAfter must be <= validUntil");
        }

        return keccak256(
            encodeAbiParameters(parseAbiParameters("address, address, uint256, uint256, bool"), [
                getAddress(payerAddress),
                getAddress(tokenAddress),
                BigInt(validUntil),
                BigInt(validAfter),
                isActivation,
            ])
        );
    }

    private computeEthSignedDigest(digest: Hex): Hex {
        return keccak256(
            encodePacked(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", digest])
        );
    }
}

type ParsedDerSignature = {
    r: bigint;
    s: bigint;
};

function parseDerSignature(derBytes: Uint8Array): ParsedDerSignature {
    if (derBytes.length < 8) {
        throw new Error("invalid_der_signature: too short");
    }

    let cursor = 0;

    if (derBytes[cursor] !== 0x30) {
        throw new Error("invalid_der_signature: expected sequence");
    }
    cursor += 1;

    const seqLen = readDerLength(derBytes, cursor);
    cursor = seqLen.next;

    if (seqLen.length !== derBytes.length - cursor) {
        throw new Error("invalid_der_signature: malformed sequence length");
    }

    if (derBytes[cursor] !== 0x02) {
        throw new Error("invalid_der_signature: expected integer for r");
    }
    cursor += 1;

    const rLen = readDerLength(derBytes, cursor);
    cursor = rLen.next;
    const rSlice = derBytes.slice(cursor, cursor + rLen.length);
    cursor += rLen.length;

    if (derBytes[cursor] !== 0x02) {
        throw new Error("invalid_der_signature: expected integer for s");
    }
    cursor += 1;

    const sLen = readDerLength(derBytes, cursor);
    cursor = sLen.next;
    const sSlice = derBytes.slice(cursor, cursor + sLen.length);
    cursor += sLen.length;

    if (cursor !== derBytes.length) {
        throw new Error("invalid_der_signature: trailing bytes");
    }

    return {
        r: bytesToBigInt(trimIntegerPrefix(rSlice)),
        s: bytesToBigInt(trimIntegerPrefix(sSlice)),
    };
}

function readDerLength(input: Uint8Array, offset: number): { length: number; next: number } {
    const first = input[offset];
    if (first === undefined) {
        throw new Error("invalid_der_signature: unexpected end of input");
    }

    if ((first & 0x80) === 0) {
        return { length: first, next: offset + 1 };
    }

    const octets = first & 0x7f;
    if (octets === 0 || octets > 2) {
        throw new Error("invalid_der_signature: unsupported length encoding");
    }

    if (offset + 1 + octets > input.length) {
        throw new Error("invalid_der_signature: length out of range");
    }

    let length = 0;
    for (let i = 0; i < octets; i += 1) {
        length = (length << 8) | input[offset + 1 + i];
    }

    return { length, next: offset + 1 + octets };
}

function trimIntegerPrefix(bytes: Uint8Array): Uint8Array {
    if (bytes.length > 1 && bytes[0] === 0x00) {
        return bytes.slice(1);
    }
    return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    let result = 0n;
    for (const value of bytes) {
        result = (result << 8n) + BigInt(value);
    }
    return result;
}

function toPadded32Hex(value: bigint): string {
    if (value < 0n) {
        throw new Error("invalid_signature_component: negative value");
    }
    const raw = value.toString(16);
    if (raw.length > 64) {
        throw new Error("invalid_signature_component: exceeds 32 bytes");
    }
    return raw.padStart(64, "0");
}

function buildSignatureHex(rHex: string, sHex: string, v: 27 | 28): Hex {
    const vHex = v === 27 ? "1b" : "1c";
    return `0x${rHex}${sHex}${vHex}` as Hex;
}

function hexToBytes(value: Hex): Uint8Array {
    const stripped = value.startsWith("0x") ? value.slice(2) : value;
    if (stripped.length % 2 !== 0) {
        throw new Error("invalid_hex: length must be even");
    }

    const bytes = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < stripped.length; i += 2) {
        bytes[i / 2] = Number.parseInt(stripped.slice(i, i + 2), 16);
    }
    return bytes;
}
