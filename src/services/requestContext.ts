import { randomUUID } from "node:crypto";
import type express from "express";

const REQUEST_ID_HEADER = "x-request-id";

export type RequestContext = {
    requestId: string;
    startedAtMs: number;
};

export function createRequestContext(req: express.Request, res: express.Response): RequestContext {
    const inboundHeader = req.headers[REQUEST_ID_HEADER];
    const requestId =
        typeof inboundHeader === "string" && inboundHeader.trim() !== ""
            ? inboundHeader.trim()
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
