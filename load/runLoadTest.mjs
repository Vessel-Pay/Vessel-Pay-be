#!/usr/bin/env node

import process from "node:process";
import { performance } from "node:perf_hooks";
import fs from "node:fs";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const BASE_URL = process.env.LOAD_BASE_URL;
const PATH = process.env.LOAD_PATH ?? "/health";
const DURATION_SECONDS = parseNumber(process.env.LOAD_DURATION_SECONDS, 30);
const WARMUP_SECONDS = Math.max(0, parseNumber(process.env.LOAD_WARMUP_SECONDS, 0));
const CONCURRENCY = Math.max(1, Math.floor(parseNumber(process.env.LOAD_CONCURRENCY, 20)));
const TIMEOUT_MS = Math.max(250, Math.floor(parseNumber(process.env.LOAD_TIMEOUT_MS, 5000)));
const MAX_ERROR_RATE = parseNumber(process.env.LOAD_MAX_ERROR_RATE, 0.01);
const MAX_P95_MS = parseNumber(process.env.LOAD_MAX_P95_MS, 800);
const MAX_P99_MS = parseNumber(process.env.LOAD_MAX_P99_MS, 1200);
const REPORT_FILE = process.env.LOAD_REPORT_FILE?.trim() || "";

if (!BASE_URL) {
  console.error("LOAD_BASE_URL is required (example: https://api.example.com/prod)");
  process.exit(1);
}

const normalizedBaseUrl = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;
const normalizedPath = PATH.startsWith("/") ? PATH : `/${PATH}`;
const targetUrl = `${normalizedBaseUrl}${normalizedPath}`;

const latencies = [];
let total = 0;
let success = 0;
let failed = 0;
let timeoutFailures = 0;
const statusCounts = new Map();
const startedAt = performance.now();
const measurementStartAt = startedAt + WARMUP_SECONDS * 1000;
const endAt = startedAt + DURATION_SECONDS * 1000;

async function singleRequest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    const elapsed = performance.now() - start;
    const now = performance.now();
    if (now >= measurementStartAt) {
      latencies.push(elapsed);
      total += 1;
    }

    if (now >= measurementStartAt) {
      if (response.ok) {
        success += 1;
      } else {
        failed += 1;
      }
    }
    if (now >= measurementStartAt) {
      const statusKey = String(response.status);
      statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);
    }
  } catch (error) {
    const elapsed = performance.now() - start;
    const now = performance.now();
    if (now >= measurementStartAt) {
      latencies.push(elapsed);
      total += 1;
      failed += 1;
      if (error instanceof Error && error.name === "AbortError") {
        timeoutFailures += 1;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function worker() {
  while (performance.now() < endAt) {
    await singleRequest();
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);

const totalDurationMs = performance.now() - startedAt;
const sortedLatencies = [...latencies].sort((a, b) => a - b);
const p50 = percentile(sortedLatencies, 50);
const p95 = percentile(sortedLatencies, 95);
const p99 = percentile(sortedLatencies, 99);
const errorRate = total > 0 ? failed / total : 1;
const rps = totalDurationMs > 0 ? (total / totalDurationMs) * 1000 : 0;

const report = {
  targetUrl,
  warmupSeconds: WARMUP_SECONDS,
  durationSeconds: DURATION_SECONDS,
  concurrency: CONCURRENCY,
  timeoutMs: TIMEOUT_MS,
  totals: {
    total,
    success,
    failed,
    timeoutFailures,
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  },
  latencyMs: {
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    p99: Number(p99.toFixed(2)),
  },
  throughput: {
    requestsPerSecond: Number(rps.toFixed(2)),
  },
  budgets: {
    maxErrorRate: MAX_ERROR_RATE,
    maxP95Ms: MAX_P95_MS,
    maxP99Ms: MAX_P99_MS,
  },
};

console.log(JSON.stringify(report, null, 2));

if (REPORT_FILE) {
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Load report written to ${REPORT_FILE}`);
}

const budgetFailures = [];
if (errorRate > MAX_ERROR_RATE) {
  budgetFailures.push(`error_rate_exceeded: ${(errorRate * 100).toFixed(2)}% > ${(MAX_ERROR_RATE * 100).toFixed(2)}%`);
}
if (p95 > MAX_P95_MS) {
  budgetFailures.push(`p95_exceeded: ${p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
}
if (p99 > MAX_P99_MS) {
  budgetFailures.push(`p99_exceeded: ${p99.toFixed(2)}ms > ${MAX_P99_MS}ms`);
}

if (budgetFailures.length > 0) {
  console.error("Load test failed budget checks:");
  for (const failure of budgetFailures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Load test passed budget checks.");
