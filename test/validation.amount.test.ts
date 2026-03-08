import { describe, expect, it } from "vitest";
import { parseDecimalAmountToBaseUnits } from "../src/services/validation.js";

describe("Amount parsing security and correctness", () => {
    it("converts decimal strings to fixed base units exactly", () => {
        expect(parseDecimalAmountToBaseUnits("100", 6)).toBe(100000000n);
        expect(parseDecimalAmountToBaseUnits("100.5", 6)).toBe(100500000n);
        expect(parseDecimalAmountToBaseUnits("0.000001", 6)).toBe(1n);
    });

    it("rejects more than supported decimal places", () => {
        expect(() => parseDecimalAmountToBaseUnits("1.0000001", 6)).toThrow(
            "amount supports up to 6 decimal places"
        );
    });

    it("rejects scientific notation and malformed formats", () => {
        expect(() => parseDecimalAmountToBaseUnits("1e3", 6)).toThrow("amount must be a decimal string");
        expect(() => parseDecimalAmountToBaseUnits("-1", 6)).toThrow("amount must be a decimal string");
        expect(() => parseDecimalAmountToBaseUnits("abc", 6)).toThrow("amount must be a decimal string");
    });

    it("rejects zero or non-positive amounts", () => {
        expect(() => parseDecimalAmountToBaseUnits("0", 6)).toThrow("amount must be a positive number");
        expect(() => parseDecimalAmountToBaseUnits("0.000000", 6)).toThrow("amount must be a positive number");
    });
});
