# Load and Concurrency Test

Task 26 requires controlled load profiles, p95/p99 latency measurement, and error-budget enforcement.

## Usage

```bash
LOAD_BASE_URL=https://89rornylmd.execute-api.us-east-1.amazonaws.com/prod npm run test:load
```

## Optional tuning

- `LOAD_PATH` default: `/health`
- `LOAD_METHOD` default: `GET`
- `LOAD_WARMUP_SECONDS` default: `0`
- `LOAD_DURATION_SECONDS` default: `30`
- `LOAD_CONCURRENCY` default: `20`
- `LOAD_TIMEOUT_MS` default: `5000`
- `LOAD_MAX_ERROR_RATE` default: `0.01` (1%)
- `LOAD_MAX_P95_MS` default: `800`
- `LOAD_MAX_P99_MS` default: `1200`
- `LOAD_JSON_BODY` optional: JSON payload for POST/PUT scenarios
- `LOAD_API_KEY` optional: inject `x-api-key` for protected routes
- `LOAD_IDEMPOTENCY_KEY_PREFIX` optional: inject unique `idempotency-key` per request (`<prefix>-<sequence>`)

The script prints a JSON report and exits non-zero if any budget threshold is exceeded.

## Official Task 26 staging profile

Use the approved non-saturating profile for release readiness evidence:

```bash
npm run test:load:staging:official
```

Profile values:

- `LOAD_CONCURRENCY=4`
- `LOAD_CONCURRENCY=2`
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

## Example protected endpoint profile

Top-up endpoint load test with per-request idempotency keys:

```bash
LOAD_BASE_URL=https://89rornylmd.execute-api.us-east-1.amazonaws.com/prod \
LOAD_PATH=/topup-idrx \
LOAD_METHOD=POST \
LOAD_API_KEY=your-topup-key \
LOAD_IDEMPOTENCY_KEY_PREFIX=load-topup \
LOAD_JSON_BODY='{"walletAddress":"0x3333333333333333333333333333333333333333","amount":"1","chain":"base"}' \
npm run test:load
```
