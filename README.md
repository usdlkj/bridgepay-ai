# pg-middleware-ai

AI-powered natural language query service for the KCIC Payment Gateway Middleware system. Ask plain-language business questions about payment transactions and receive human-readable answers backed by live data — no SQL required.

> **Port:** `3001` &nbsp;|&nbsp; **Framework:** NestJS 11 (TypeScript) &nbsp;|&nbsp; **Runtime:** Node.js 22

---

## How it works

A `POST /ask` request flows through a ten-step pipeline:

1. Check Redis cache for a repeated question
2. Prune the schema down to the 8 most relevant tables (keyword scoring)
3. Retrieve multi-turn conversation history
4. Call LLM #1 to generate a SQL `SELECT` statement
5. Validate the SQL — reject any non-SELECT or mutation attempt
6. Execute against a **read-only** pg-middleware PostgreSQL connection
7. Call LLM #2 to synthesise a natural-language answer from the results
8. Cache result (Redis, 1 h TTL)
9. Save session turn
10. Log usage to `ai_usage_log` (fire-and-forget)

---

## Prerequisites

- Node.js 22 + pnpm
- PostgreSQL — two connections required:
  - AI database (read-write, for `ai_usage_log` and `llm_api_keys`)
  - pg-middleware database (read-only role `ai_readonly`)
- Redis (optional — cache and session memory degrade gracefully if absent)

---

## Local setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env — see Configuration section below

# 3. Seed LLM API keys (encrypted at rest)
node scripts/seed-llm-keys.js

# 4. Start in watch mode
pnpm run start:dev
```

Health check: `GET http://localhost:3001/health`

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in the values.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `NODE_ENV` | `development` | `development` / `production` |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `pretty` | `pretty` for dev, `json` for production |
| **Database — AI** |||
| `DB_AI_HOST` / `DB_AI_PORT` | `localhost` / `5432` | AI database host |
| `DB_AI_USERNAME` / `DB_AI_PASSWORD` | — | Read-write credentials for AI tables |
| `DB_AI_DATABASE` | — | AI database name |
| **Database — pg-middleware (read-only)** |||
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | pg-middleware database host |
| `DB_USERNAME` / `DB_PASSWORD` | `ai_readonly` / — | Read-only credentials |
| `DB_DATABASE` | — | pg-middleware database name |
| **Auth** |||
| `JWT_SECRET` | — | Must match pg-middleware's `LOGIN_SECRET` |
| `BYPASS_JWT_AUTH` | — | Set to `true` to skip JWT validation (dev only) |
| **LLM** |||
| `LLM_ENCRYPTION_KEY` | — | 64-char hex key for AES-256-GCM (generate below) |
| `LLM_SQL_PROVIDER` | `anthropic` | Provider for SQL generation: `anthropic` / `openai` / `qwen` / `ollama` |
| `LLM_SQL_MODEL` | `claude-sonnet-4-6` | Model for SQL generation |
| `LLM_ANSWER_PROVIDER` | `anthropic` | Provider for answer synthesis |
| `LLM_ANSWER_MODEL` | `claude-sonnet-4-6` | Model for answer synthesis |
| **Optional** |||
| `REDIS_URL` | — | e.g. `redis://localhost:6379` — enables caching and session memory |
| `SCHEMA_PATH` | `schema/SCHEMA_V1.json` | Path to schema JSON (relative or absolute) |
| `SCHEMA_PRUNING_ENABLED` | `true` | Keyword-based schema pruning |

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## LLM API keys

Keys are stored **encrypted** in the `llm_api_keys` database table — never in environment variables. Use the seed script to add or update them:

```bash
# Set plain-text keys in env first, then run:
ANTHROPIC_KEY=sk-ant-... node scripts/seed-llm-keys.js
```

Supported providers: `anthropic`, `openai`, `qwen`, `ollama`.

---

## API

### POST /ask

Ask a natural language question. Requires a valid JWT (`Bearer` token from pg-middleware login).

```bash
curl -X POST http://localhost:3001/ask \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"question": "How many paid Xendit orders came in last week?", "include_sql": true}'
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | Natural language question |
| `include_sql` | boolean | no | Include the generated SQL in the response |
| `session_id` | string | no | UUID for multi-turn conversation context |

**Response:**

```json
{
  "answer": "There were 1,284 paid orders through Xendit between...",
  "sql": "SELECT COUNT(*) FROM orders WHERE ...",
  "sources": [{ "count": "1284" }],
  "rowCount": 1
}
```

### GET /health

Returns service status. No auth required.

```json
{ "status": "ok", "service": "pg-middleware-ai", "timestamp": "..." }
```

---

## SQL safety

Three independent layers prevent write operations against the production database:

1. **System prompt** — instructs the LLM to generate only `SELECT` with `LIMIT`
2. **`validateSql()`** — rejects any query that is not a `SELECT`, lacks a `LIMIT`, or contains mutation keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`)
3. **Read-only DB role** — the PostgreSQL user has no write privileges

---

## Docker

```bash
# Build
docker build -t docker.kcic.co.id/pg-middleware-ai:latest .

# Run
docker run -p 3001:3001 --env-file .env docker.kcic.co.id/pg-middleware-ai:latest
```

Secrets can be injected via Docker secrets — `docker-entrypoint.sh` reads `/run/secrets/*` and exports them as environment variables before starting the app.

---

## Development commands

```bash
pnpm run start:dev    # watch mode
pnpm run build        # compile TypeScript
pnpm run start:prod   # run compiled output
pnpm run test         # unit tests (Jest)
pnpm run test:e2e     # end-to-end tests
pnpm run lint         # ESLint + Prettier fix
```

---

## Project structure

```
src/
├── db-qa/                  Core feature module
│   ├── db-qa.controller.ts       GET /health, POST /ask
│   ├── db-qa-agent.service.ts    Main orchestrator (10-step pipeline)
│   ├── schema.service.ts         Schema loading + keyword pruning
│   ├── query-executor.service.ts SQL validation + execution
│   ├── ask-cache.service.ts      Redis-backed response cache
│   ├── conversation-session.service.ts  Multi-turn session state
│   ├── ai-logs-db.service.ts     Async usage logging
│   ├── jwt-auth.guard.ts         JWT validation guard
│   └── dto / entities /
└── llm/                    LLM provider abstraction
    ├── llm-resolver.service.ts   Provider dispatch
    ├── llm-config-db.service.ts  Encrypted key management
    ├── llm-crypto.service.ts     AES-256-GCM encrypt/decrypt
    └── adapters/                 Anthropic, OpenAI, Qwen, Ollama

schema/
└── SCHEMA_V1.json          pg-middleware table schema (LLM knowledge base)

scripts/
└── seed-llm-keys.js        Seed encrypted LLM API keys into DB
```

---

## Documentation

- [Design document](DOCS/01_DESIGN.md) — architecture, database schema, design decisions
- [Prompt & Schema Management](DOCS/features/PROMPT_SCHEMA_MANAGEMENT.md) — planned feature: DB-backed prompts and schema
