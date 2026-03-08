import dotenv from "dotenv";

dotenv.config();

type QuoteResponse = {
    amountOut: string;
    fee: string;
    totalUserPays: string;
};

const BASE_URL = process.env.DEMO_BASE_URL?.trim() || "https://89rornylmd.execute-api.us-east-1.amazonaws.com/prod";
const TOKEN_IN = process.env.DEMO_TOKEN_IN?.trim() || process.env.IDRX_TOKEN_ADDRESS?.trim() || "";
const TOKEN_OUT = process.env.DEMO_TOKEN_OUT?.trim() || process.env.IDRX_TOKEN_ADDRESS?.trim() || "";
const ITERATIONS = Number.parseInt(process.env.DEMO_ITERATIONS ?? "40", 10);
const CHAIN_ID = Number.parseInt(process.env.DEMO_CHAIN_ID ?? "84532", 10);

if (!TOKEN_IN || !TOKEN_OUT) {
    console.error("Missing DEMO_TOKEN_IN/DEMO_TOKEN_OUT (or IDRX_TOKEN_ADDRESS fallback).");
    process.exit(1);
}

function randomAmountMicro(): bigint {
    const whole = 5 + Math.floor(Math.random() * 150);
    const micro = Math.floor(Math.random() * 1_000_000);
    return BigInt(whole) * 1_000_000n + BigInt(micro);
}

function toMinAmountOut(amountOut: string, slippageBps = 150): string {
    try {
        const out = BigInt(amountOut);
        return ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString();
    } catch {
        return "0";
    }
}

async function run(): Promise<void> {
    console.log("=== Demo Activity Generator ===");
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Token pair: ${TOKEN_IN} -> ${TOKEN_OUT}`);
    console.log(`Iterations: ${ITERATIONS}`);

    let quoteSuccess = 0;
    let buildSuccess = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
        const amountIn = randomAmountMicro();
        const autoRoute = Math.random() > 0.35;

        try {
            const quoteRes = await fetch(
                `${BASE_URL}/swap/quote?tokenIn=${TOKEN_IN}&tokenOut=${TOKEN_OUT}&amountIn=${amountIn.toString()}&chainId=${CHAIN_ID}`
            );

            if (!quoteRes.ok) {
                const text = await quoteRes.text();
                console.warn(`[${i + 1}] quote failed: ${text}`);
                continue;
            }

            quoteSuccess += 1;
            const quote = (await quoteRes.json()) as QuoteResponse;

            const buildRes = await fetch(`${BASE_URL}/swap/build`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tokenIn: TOKEN_IN,
                    tokenOut: TOKEN_OUT,
                    amountIn: amountIn.toString(),
                    minAmountOut: toMinAmountOut(quote.amountOut),
                    chainId: CHAIN_ID,
                    autoRoute,
                }),
            });

            if (!buildRes.ok) {
                const text = await buildRes.text();
                console.warn(`[${i + 1}] build failed: ${text}`);
            } else {
                buildSuccess += 1;
            }

            if ((i + 1) % 10 === 0) {
                console.log(`Progress ${i + 1}/${ITERATIONS} | quote=${quoteSuccess} build=${buildSuccess}`);
            }

            // Add small pacing to mimic realistic user flow.
            await new Promise((resolve) => setTimeout(resolve, 120));
        } catch (error) {
            console.warn(`[${i + 1}] request error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const dashboardRes = await fetch(`${BASE_URL}/ai/merchant/dashboard?windowDays=30`);
    const dashboardPayload = await dashboardRes.text();

    console.log("=== Demo Completed ===");
    console.log(`quote success: ${quoteSuccess}/${ITERATIONS}`);
    console.log(`build success: ${buildSuccess}/${ITERATIONS}`);
    console.log("merchant dashboard payload:");
    console.log(dashboardPayload);
}

void run();
