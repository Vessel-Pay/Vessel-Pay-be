# Load and Concurrency Test

Task 26 requires controlled load profiles, p95/p99 latency measurement, and error-budget enforcement.

## Usage

```bash
LOAD_BASE_URL=https://89rornylmd.execute-api.us-east-1.amazonaws.com/prod npm run test:load
```

## Optional tuning

- `LOAD_PATH` default: `/health`
- `LOAD_WARMUP_SECONDS` default: `0`
- `LOAD_DURATION_SECONDS` default: `30`
- `LOAD_CONCURRENCY` default: `20`
- `LOAD_TIMEOUT_MS` default: `5000`
- `LOAD_MAX_ERROR_RATE` default: `0.01` (1%)
- `LOAD_MAX_P95_MS` default: `800`
- `LOAD_MAX_P99_MS` default: `1200`

The script prints a JSON report and exits non-zero if any budget threshold is exceeded.

## Official Task 26 staging profile

Use the approved non-saturating profile for release readiness evidence:

```bash
npm run test:load:staging:official
```

Profile values:

- `LOAD_CONCURRENCY=4`
- `LOAD_WARMUP_SECONDS=10`
- `LOAD_DURATION_SECONDS=30`
- `LOAD_MAX_ERROR_RATE=0.05`
- `LOAD_MAX_P95_MS=800`
- `LOAD_MAX_P99_MS=1500`

To generate an attachable JSON artifact:

```bash
npm run test:load:staging:official:report
```

Output file:

- `reports/load/staging-official.latest.json`
