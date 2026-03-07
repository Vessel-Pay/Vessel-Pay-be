import { beforeAll, describe, expect, it } from "vitest";

process.env.RPC_URL = "https://example-rpc.local";
process.env.STABLE_SWAP_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.RPC_URL_ETHERLINK = "https://example-rpc-etherlink.local";
process.env.STABLE_SWAP_ADDRESS_ETHERLINK = "0x0000000000000000000000000000000000000000";
process.env.KMS_KEY_ID = "kms-key-id";
process.env.PAYMASTER_SIGNER_ADDRESS = "0x2222222222222222222222222222222222222222";

let handler: (event: any, context: any, callback?: any) => Promise<any>;

describe("lambda handler path normalization", () => {
    beforeAll(async () => {
        ({ handler } = await import("../src/lambda.js"));
    });

    it("serves /health when API Gateway forwards /prod/health", async () => {
        const response = await handler(
            {
                version: "2.0",
                routeKey: "GET /health",
                rawPath: "/prod/health",
                rawQueryString: "",
                headers: {
                    host: "89rornylmd.execute-api.us-east-1.amazonaws.com",
                },
                requestContext: {
                    stage: "prod",
                    http: {
                        method: "GET",
                        path: "/prod/health",
                        sourceIp: "127.0.0.1",
                        userAgent: "vitest",
                    },
                },
                isBase64Encoded: false,
            },
            {}
        );

        expect(response.statusCode).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain('"status":"ok"');
    });

    it("handles warm invocation after first request", async () => {
        const first = await handler(
            {
                version: "2.0",
                routeKey: "GET /health",
                rawPath: "/prod/health",
                rawQueryString: "",
                headers: {
                    host: "89rornylmd.execute-api.us-east-1.amazonaws.com",
                },
                requestContext: {
                    stage: "prod",
                    http: {
                        method: "GET",
                        path: "/prod/health",
                        sourceIp: "127.0.0.1",
                        userAgent: "vitest",
                    },
                },
                isBase64Encoded: false,
            },
            {}
        );

        const second = await handler(
            {
                version: "2.0",
                routeKey: "GET /signer",
                rawPath: "/prod/signer",
                rawQueryString: "",
                headers: {
                    host: "89rornylmd.execute-api.us-east-1.amazonaws.com",
                },
                requestContext: {
                    stage: "prod",
                    http: {
                        method: "GET",
                        path: "/prod/signer",
                        sourceIp: "127.0.0.1",
                        userAgent: "vitest",
                    },
                },
                isBase64Encoded: false,
            },
            {}
        );

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(typeof second.body).toBe("string");
        expect(second.body).toContain('"signerAddress":"0x2222222222222222222222222222222222222222"');
    });
});
