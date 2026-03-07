type LogLevel = "info" | "warn" | "error";

type LogPayload = {
    requestId: string;
    endpoint: string;
    method: string;
    latencyMs?: number;
    chainId?: number;
    result?: "success" | "failure";
    errorClass?: string;
    message: string;
};

function write(level: LogLevel, payload: LogPayload): void {
    const base = {
        timestamp: new Date().toISOString(),
        level,
        ...payload,
    };

    console.log(JSON.stringify(base));
}

export const logger = {
    info(payload: LogPayload): void {
        write("info", payload);
    },
    warn(payload: LogPayload): void {
        write("warn", payload);
    },
    error(payload: LogPayload): void {
        write("error", payload);
    },
};
