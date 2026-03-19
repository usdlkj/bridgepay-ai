# pg-middleware-ai — Design Document

## 1. Overview

`pg-middleware-ai` is an AI-powered natural language query service for the KCIC Payment Gateway Middleware system. It allows authorised users to ask plain-language business questions (e.g. _"How many paid Xendit orders came in last week?"_) and receive human-readable answers backed by live data, without needing to write SQL.

The service is a standalone NestJS application that sits alongside the existing `pg-middleware` system. It connects — read-only — to the pg-middleware PostgreSQL database and uses a large language model (LLM) to translate questions into SQL queries, execute them safely, and synthesise the results into natural language answers.

---

## 2. Goals

- Provide a conversational interface to pg-middleware operational data.
- Support multiple LLM providers (Anthropic Claude, OpenAI GPT, Alibaba Qwen, local Ollama) switchable via configuration.
- Guarantee safety: never allow write operations against the production database.
- Minimise LLM token costs through schema pruning and response caching.
- Integrate with the existing pg-middleware authentication system (shared JWT secret).
- Remain deployable on the same AWS infrastructure alongside pg-middleware.

---

## 3. Architecture

### 3.1 High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                        pg-middleware-ai                      │
│                                                             │
│  POST /ask ──► DbQaAgentService (orchestrator)              │
│                │                                            │
│                ├── SchemaService          (schema pruning)  │
│                ├── ConversationSession    (multi-turn)      │
│                ├── AskCacheService        (Redis TTL cache) │
│                ├── LlmResolverService     (provider router) │
│                │     ├── AnthropicAdapter                   │
│                │     ├── OpenaiAdapter                      │
│                │     ├── QwenAdapter                        │
│                │     └── OllamaAdapter                      │
│                ├── QueryExecutorService   (SQL safety + run)│
│                └── AiLogsDbService        (observability)   │
│                                                             │
│  TypeORM ──► AI PostgreSQL DB (ai_usage_log, llm_api_keys)  │
│  pg.Pool ──► pg-middleware PostgreSQL DB (read-only)        │
│  ioredis ──► Redis (optional — cache + sessions)            │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Request Pipeline

Every `POST /ask` call flows through ten steps in sequence:

```
1.  AskCacheService.get(question)
      └─ Cache hit? → return immediately (status: cache_hit)

2.  SchemaService.getSchemaForPromptFiltered(question)
      └─ Keyword-score all 11 tables → pass top 8 to LLM

3.  ConversationSessionService.getTurns(session_id)
      └─ Prepend prior Q&A turns (up to 5) for multi-turn context

4.  LlmResolverService → SQL generation call
      └─ System prompt: "Generate a single PostgreSQL SELECT with LIMIT"
      └─ Output: raw SQL string

5.  QueryExecutorService.validateSql(sql)
      └─ Reject non-SELECT, missing LIMIT, or mutation keywords

6.  QueryExecutorService.execute(sql)
      └─ read-only pg.Pool → pg-middleware PostgreSQL DB

7.  LlmResolverService → answer synthesis call
      └─ Input: question + first 50 rows of results
      └─ Output: natural-language answer

8.  AskCacheService.set(question, result, TTL=1h)

9.  ConversationSessionService.appendTurn(session_id, q, a)

10. AiLogsDbService.logUsage(...)   ← fire-and-forget
```

---

## 4. Module Structure

```
src/
├── main.ts                          NestJS bootstrap (port 3001, Pino logging)
├── app.module.ts                    Root module: ConfigModule, TypeORM, DbQaModule
├── app.controller.ts                GET / → placeholder
│
├── db-qa/
│   ├── db-qa.module.ts
│   ├── db-qa.controller.ts          GET /health, POST /ask
│   ├── db-qa-agent.service.ts       Main orchestrator (10-step pipeline)
│   ├── schema.service.ts            Schema loading + keyword pruning
│   ├── query-executor.service.ts    SQL validation + execution (pg.Pool)
│   ├── ask-cache.service.ts         Redis-backed question/answer cache
│   ├── conversation-session.service.ts  Multi-turn session state
│   ├── ai-logs-db.service.ts        Async usage logging to DB
│   ├── jwt-auth.guard.ts            JWT guard (currently disabled)
│   ├── dto/ask.dto.ts               AskDto + AskResult types
│   └── entities/ai-usage-log.entity.ts  TypeORM entity
│
└── llm/
    ├── llm.module.ts
    ├── llm-resolver.service.ts      Provider dispatch + config resolution
    ├── llm-config-db.service.ts     DB-backed key management (5-min cache)
    ├── llm-crypto.service.ts        AES-256-GCM encrypt/decrypt
    ├── adapters/
    │   ├── anthropic.adapter.ts     Claude via @anthropic-ai/sdk
    │   ├── openai.adapter.ts        GPT via openai SDK
    │   ├── qwen.adapter.ts          Alibaba Qwen (OpenAI-compatible)
    │   └── ollama.adapter.ts        Local Ollama via plain fetch
    ├── interfaces/llm-provider.interface.ts  Common LlmProvider contract
    └── entities/llm-api-key.entity.ts        TypeORM entity
```

---

## 5. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (Alpine in Docker) |
| Framework | NestJS v11 (TypeScript) |
| Language | TypeScript 5.7 |
| Package manager | pnpm |
| ORM | TypeORM 0.3 (for AI-owned tables) |
| AI Database | PostgreSQL (TypeORM-managed, auto-sync in non-prod) |
| Query target | PostgreSQL — pg-middleware DB (raw `pg.Pool`, read-only role) |
| Cache / Sessions | Redis via `ioredis` (optional) |
| LLM: Anthropic | `@anthropic-ai/sdk` — Claude Sonnet (default) |
| LLM: OpenAI | `openai` SDK |
| LLM: Qwen | `openai` SDK → Alibaba DashScope |
| LLM: Ollama | Plain `fetch` to local Ollama REST API |
| Auth | JWT HS256 via `@nestjs/jwt` (shared secret with pg-middleware) |
| Logging | `nestjs-pino` + `pino-pretty` |
| Containerisation | Docker multi-stage (Alpine), custom registry `docker.kcic.co.id` |
| CI/CD | GitHub Actions → staging VPS (auto) → prod AWS EC2 (manual gate) |
| Crypto | Node.js built-in `crypto`, AES-256-GCM |

---

## 6. API

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | none | Placeholder health-check |
| `GET` | `/health` | none | Returns service status and timestamp |
| `POST` | `/ask` | JWT Bearer *(currently disabled)* | Natural language → SQL → answer |

### POST /ask

**Request:**
```json
{
  "question": "How many paid orders came through Xendit last week?",
  "include_sql": true,
  "session_id": "optional-uuid-for-multi-turn-context"
}
```

**Response:**
```json
{
  "answer": "There were 1,284 paid orders through Xendit between...",
  "sql": "SELECT COUNT(*) FROM orders WHERE ...",
  "sources": [ { "count": "1284" } ],
  "rowCount": 1
}
```

---

## 7. Database Design

### 7.1 AI-owned tables (TypeORM-managed)

#### `llm_api_keys`
Stores LLM provider credentials, encrypted at rest.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | auto-increment |
| `provider_code` | varchar(50) UNIQUE | `anthropic`, `openai`, `qwen`, `ollama` |
| `api_key` | text nullable | AES-256-GCM encrypted (`iv:authTag:ciphertext`) |
| `base_url` | varchar(500) nullable | Override URL for Qwen / Ollama |
| `is_active` | boolean | Only active rows are used |
| `created_at` / `updated_at` | timestamp | Auto-managed |

#### `ai_usage_log`
Audit trail of every `/ask` call for observability and cost analysis.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | auto-increment |
| `user_id` | int nullable | FK to pg-middleware users |
| `llm_provider_id` | int nullable | FK to `llm_api_keys.id` |
| `question` | varchar(2000) | Truncated to 2000 chars |
| `sql_text` | text nullable | Generated SQL |
| `row_count` | int nullable | Rows returned by the query |
| `latency_ms` | int nullable | End-to-end request duration |
| `tokens_in` | int nullable | Combined input tokens (both LLM calls) |
| `tokens_out` | int nullable | Combined output tokens |
| `status` | varchar(50) | `success`, `cache_hit`, `empty_sql`, `validation_failed`, `execution_failed` |
| `created_at` | timestamp | Auto |

### 7.2 Read-only target: pg-middleware tables

The service queries 11 existing tables in the pg-middleware database. It never writes to them. The schema knowledge base is encoded in `schema/SCHEMA_V1.json` with column descriptions, relationships, and common query patterns.

| Table | Description |
|---|---|
| `orders` | Core transaction table — every payment attempt |
| `pg_responses` | Audit log of every gateway callback per order |
| `services` | Gateway + payment type + provider config; fee rules |
| `payment_gateways` | Registered gateways with load-balancing weights |
| `payment_types` | Payment method types (VA, Credit Card, QR) |
| `payment_providers` | Banks and e-wallets (BCA, BRI, BNI, OVO, DANA, LinkAja) |
| `notif_logs` | Webhook delivery log to the ticketing system |
| `api_logs` | Raw nginx access log (always filter by date — can be large) |
| `api_log_calcs` | Pre-aggregated daily API stats per endpoint |
| `api_log_debugs` | Auth/signature debug log for incoming requests |
| `clients` | Merchant accounts |
| `users` | Backoffice admin user accounts |
| `reports` | Reconciliation/settlement report records |

---

## 8. Key Design Decisions

### 8.1 Two-LLM Pattern
SQL generation and answer synthesis use separate LLM calls — and can be configured to use different providers and models. This allows using a cheaper, faster model for structured SQL generation and a more capable model for natural-language answers.

### 8.2 Multi-Provider LLM Abstraction
A common `LlmProvider` interface is implemented by four adapters (Anthropic, OpenAI, Qwen, Ollama). The active provider and model are selected via environment variables (`LLM_SQL_PROVIDER`, `LLM_ANSWER_PROVIDER`), requiring no code changes to switch providers.

### 8.3 Encrypted API Keys in Database
LLM API keys are never stored in plaintext environment variables. They are AES-256-GCM encrypted at rest in `llm_api_keys`, decrypted on demand by `LlmCryptoService`, and cached in-memory for 5 minutes to minimise DB round-trips.

### 8.4 Defence-in-Depth SQL Safety
Three independent layers prevent write operations:
1. **System prompt** instructs the LLM to generate only `SELECT` statements with a `LIMIT`.
2. **`validateSql()`** enforces this in application code — rejects anything that is not a `SELECT`, lacks a `LIMIT`, or contains mutation keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`).
3. **Read-only DB role** — the `pg.Pool` connects as a PostgreSQL user with no write privileges.

### 8.5 Keyword-Based Schema Pruning
Sending the full 11-table schema in every prompt is expensive and noisy. `SchemaService` tokenises the question and scores each table using keyword overlap, passing only the top 8 most relevant tables to the LLM. This reduces prompt size, cost, and hallucination risk. If no matches are found, the full schema is used as a fallback.

### 8.6 Graceful Redis Degradation
Both caching (`AskCacheService`) and session memory (`ConversationSessionService`) check for `REDIS_URL` at startup. If Redis is not available, caching is silently disabled and sessions fall back to an in-process `Map`. The service is fully functional without Redis.

### 8.7 Shared JWT Authentication
The JWT guard validates tokens issued by pg-middleware's existing login endpoint (same `JWT_SECRET`). Existing authenticated users can call `/ask` without a separate login flow. The `BYPASS_JWT_AUTH=true` env var allows bypassing auth in development.

> **Note:** As of the time of writing, `@UseGuards(JwtAuthGuard)` on `POST /ask` is commented out, making the endpoint publicly accessible. This should be re-enabled before any production exposure.

### 8.8 Fire-and-Forget Observability
`AiLogsDbService.logUsage()` is called without `await` so that a logging failure never blocks or affects the API response. Errors are silently swallowed. This is an intentional trade-off: observability data is best-effort, not critical path.

---

## 9. Configuration Reference

All configuration is via environment variables. See `.env.example` for a full template.

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default `3001`) |
| `NODE_ENV` | `development` / `production` |
| `DB_AI_HOST` / `DB_AI_PORT` / `DB_AI_DATABASE` | TypeORM AI database connection |
| `DB_AI_USERNAME` / `DB_AI_PASSWORD` | TypeORM AI database credentials |
| `DB_HOST` / `DB_PORT` / `DB_DATABASE` | pg-middleware read-only DB connection |
| `DB_USERNAME` / `DB_PASSWORD` | Read-only DB credentials |
| `REDIS_URL` | Redis connection string (optional) |
| `JWT_SECRET` / `LOGIN_SECRET` | Shared JWT secret with pg-middleware |
| `BYPASS_JWT_AUTH` | Set to `true` to skip JWT validation (dev only) |
| `LLM_ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM |
| `LLM_SQL_PROVIDER` / `LLM_SQL_MODEL` | Provider + model for SQL generation |
| `LLM_ANSWER_PROVIDER` / `LLM_ANSWER_MODEL` | Provider + model for answer synthesis |
| `SCHEMA_PRUNING_ENABLED` | Enable keyword-based schema pruning (default `true`) |

---

## 10. Deployment

The service runs as a Docker container alongside pg-middleware on AWS EC2.

- **Registry:** `docker.kcic.co.id`
- **Port:** `3001`
- **Dockerfile:** Multi-stage Alpine build, runs as non-root `app` user
- **Secrets:** Injected via Docker secrets (`/run/secrets/*`) by `docker-entrypoint.sh`
- **CI/CD:** GitHub Actions — auto-deploy to staging on `main` push, manual approval gate for production

---

## 11. Known Issues and Planned Work

| Issue / Gap | Notes |
|---|---|
| ~~JWT guard is disabled~~ | Fixed — `@UseGuards(JwtAuthGuard)` is now active on `POST /ask`. |
| ~~`mysql2` in dependencies~~ | Fixed — removed from `package.json`. |
| ~~`dist/` committed to git~~ | Not an issue — `dist/` was never tracked; `.gitignore` already excludes it. |
| System prompts hardcoded | SQL generation and answer synthesis prompts are strings in `db-qa-agent.service.ts`. Any change requires a code edit and redeploy. **Planned:** move to `prompt_templates` DB table. See [PROMPT_SCHEMA_MANAGEMENT.md](features/PROMPT_SCHEMA_MANAGEMENT.md). |
| Schema definition is a static file | `schema/SCHEMA_V1.json` must be updated in the repo and redeployed when pg-middleware schema changes. **Planned:** DB-backed `schema_definitions` table with file fallback. See [PROMPT_SCHEMA_MANAGEMENT.md](features/PROMPT_SCHEMA_MANAGEMENT.md). |