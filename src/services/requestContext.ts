import { randomUUID } from "node:crypto";
import type express from "express";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type RequestContext = {
    requestId: string;
    startedAtMs: number;
};

export function createRequestContext(req: express.Request, res: express.Response): RequestContext {
    const inboundHeader = req.headers[REQUEST_ID_HEADER];
    const inboundValue = typeof inboundHeader === "string" ? inboundHeader.trim() : "";
    const requestId =
        inboundValue !== "" && SAFE_REQUEST_ID_PATTERN.test(inboundValue)
            ? inboundValue
            : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);

    return {
        requestId,
        startedAtMs: Date.now(),
    };
}

export function getLatencyMs(context: RequestContext): number {
    return Date.now() - context.startedAtMs;
}
