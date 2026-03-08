type MetricName =
    | "PaymasterSignSuccess"
    | "PaymasterSignFailure"
    | "SwapQuoteSuccess"
    | "SwapQuoteFailure"
    | "SwapBuildSuccess"
    | "SwapBuildFailure"
    | "TopupSuccess"
    | "TopupFailure"
    | "AiRouterRecommendationAccepted"
    | "AiRouterFallbackUsed"
    | "PaymasterRiskBlocked"
    | "UserOperationSubmissionFailure";

const DEFAULT_NAMESPACE = process.env.CLOUDWATCH_METRICS_NAMESPACE || "Vessel/API";

export function emitCountMetric(metricName: MetricName, value = 1, dimensions?: Record<string, string>): void {
    const metricPayload = {
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
                {
                    Namespace: DEFAULT_NAMESPACE,
                    Dimensions: [dimensions ? Object.keys(dimensions) : []],
                    Metrics: [{ Name: metricName, Unit: "Count" }],
                },
            ],
        },
        ...(dimensions || {}),
        [metricName]: value,
    };

    console.log(JSON.stringify(metricPayload));
}
