import dotenv from "dotenv";
import serverlessExpress from "@vendia/serverless-express";
import { app } from "./app.js";

dotenv.config();

const expressHandler = serverlessExpress({ app });

function stripStagePrefixFromPath(pathValue: unknown, stageValue: unknown): string | undefined {
    if (typeof pathValue !== "string" || typeof stageValue !== "string") {
        return undefined;
    }

    const normalizedStage = stageValue.trim();
    if (!normalizedStage) {
        return undefined;
    }

    const stagePrefix = `/${normalizedStage}`;
    if (pathValue === stagePrefix) {
        return "/";
    }

    if (pathValue.startsWith(`${stagePrefix}/`)) {
        return pathValue.slice(stagePrefix.length);
    }

    return undefined;
}

export const handler = async (event: any, context: any, callback: any) => {
    const stage = event?.requestContext?.stage;

    const nextRawPath = stripStagePrefixFromPath(event?.rawPath, stage);
    if (nextRawPath !== undefined) {
        event.rawPath = nextRawPath;
    }

    const nextHttpPath = stripStagePrefixFromPath(event?.requestContext?.http?.path, stage);
    if (nextHttpPath !== undefined && event?.requestContext?.http) {
        event.requestContext.http.path = nextHttpPath;
    }

    const nextPath = stripStagePrefixFromPath(event?.path, stage);
    if (nextPath !== undefined) {
        event.path = nextPath;
    }

    return expressHandler(event, context, callback);
};
