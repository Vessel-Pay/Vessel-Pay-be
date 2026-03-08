const DEFAULT_MAX_HORIZON_SECONDS = 24 * 60 * 60;

export class ValidationError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "ValidationError";
        this.code = code;
    }
}

export function assertSignValidityWindow(
    validAfter: number,
    validUntil: number,
    options?: { nowSeconds?: number; maxHorizonSeconds?: number }
): void {
    const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
    const maxHorizonSeconds = options?.maxHorizonSeconds ?? DEFAULT_MAX_HORIZON_SECONDS;

    if (validAfter < 0) {
        throw new ValidationError("invalid_valid_after", "validAfter must be a non-negative timestamp");
    }

    if (validUntil < nowSeconds) {
        throw new ValidationError("signature_expired", "validUntil must be current or future timestamp");
    }

    if (validAfter > validUntil) {
        throw new ValidationError("invalid_validity_window", "validAfter must be <= validUntil");
    }

    if (validUntil > nowSeconds + maxHorizonSeconds) {
        throw new ValidationError(
            "validity_horizon_exceeded",
            `validUntil must be within ${maxHorizonSeconds} seconds from now`
        );
    }
}

export function isValidationError(error: unknown): error is ValidationError {
    return error instanceof ValidationError;
}

export function parseDecimalAmountToBaseUnits(input: unknown, decimals: number): bigint {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new ValidationError("invalid_amount_config", "decimals must be an integer between 0 and 18");
    }

    const raw = typeof input === "number" ? String(input) : typeof input === "string" ? input : "";
    const amount = raw.trim();

    // Disallow scientific notation and non-decimal formats to prevent ambiguous client input.
    if (!/^\d+(\.\d+)?$/.test(amount)) {
        throw new ValidationError("invalid_amount_format", "amount must be a decimal string");
    }

    const [wholePart, fractionalPartRaw = ""] = amount.split(".");
    if (fractionalPartRaw.length > decimals) {
        throw new ValidationError(
            "invalid_amount_precision",
            `amount supports up to ${decimals} decimal places`
        );
    }

    const paddedFraction = fractionalPartRaw.padEnd(decimals, "0");
    const normalized = `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, "");
    const units = BigInt(normalized === "" ? "0" : normalized);

    if (units <= 0n) {
        throw new ValidationError("invalid_amount", "amount must be a positive number");
    }

    return units;
}
