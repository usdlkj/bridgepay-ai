# pg-middleware-ai — Development Log

## Current Status

| Environment | Version | Notes |
|---|---|---|
| Production | — | Not yet deployed |
| Development | `v0.3.0` | Enhanced health endpoint implemented |

---

## Release History

### v0.3.0 — Enhanced Health Endpoint

**What's included:**

- `GET /health` — live DB / Redis / LLM checks with `ok` / `degraded` / `error` aggregate status
- `HTTP 503` on `error`; `HTTP 200` on `ok` or `degraded`
- `HealthService` with parallel `Promise.all` checks
- `AskCacheService.ping()` method

### v0.2.0 — Prompt & Schema Management

**What's included:**

- System prompts stored in `prompt_templates` DB table — editable at runtime, no redeploy needed
- Schema definition stored in `schema_definitions` DB table with `StorageService` abstraction (local fs / S3) and bundled file fallback
- Admin API: prompt CRUD, version activation (rollback), usage stats, cache invalidation
- `AdminGuard` — role-based access for `ADMIN` / `SUPER_ADMIN` tokens
- `ai_usage_log` linked to `prompt_template_id` for per-version analytics
- Seed scripts: `seed-prompts.js`, `seed-schema.js`
- ENUM column values inlined into schema prompt to prevent invalid enum usage by LLM
- Global `LlmProviderApiExceptionFilter` — maps `OpenAI.APIError` to `HTTP 502` with sanitised message

### v0.1.0 — Initial release

**What's included:**

- `POST /ask` — natural language → SQL → answer pipeline (10-step)
- Multi-provider LLM support: Anthropic, OpenAI, Qwen, Ollama
- Encrypted LLM API keys stored in `llm_api_keys` table
- Keyword-based schema pruning (top 8 relevant tables per question)
- Redis-backed response cache and multi-turn session memory (both optional)
- AI usage logging to `ai_usage_log`
- JWT authentication (shared secret with pg-middleware)
- Docker multi-stage build + GitHub Actions CI/CD pipeline
- `GET /health` endpoint (static response)

---

## Released: v0.3.0 — Enhanced Health Endpoint

**What's included:**
- `GET /health` replaced with live dependency checks — database (`SELECT 1`), Redis (`PING`, skipped when `REDIS_URL` unset), LLM key presence (`LlmConfigDbService.getConfig`)
- Aggregated `status`: `ok` / `degraded` / `error` with per-check `{ status, detail? }` objects
- `HTTP 503` returned when `status === 'error'`; all other states return `HTTP 200`
- New `HealthService` (`src/db-qa/health.service.ts`) — all three checks run in parallel via `Promise.all`
- `AskCacheService.ping()` added to expose the Redis health check without duplicating the client

---

## Development Plan — v0.3.0

### Step 1 — HealthService

**New file: `src/db-qa/health.service.ts`**

Runs each check independently so a single failure does not block the others. Returns a typed result object.

```typescript
interface CheckResult {
  status: 'ok' | 'error';
  detail?: string;
}

interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  timestamp: string;
  checks: {
    database: CheckResult;
    redis: CheckResult | { status: 'skip' };
    llm: CheckResult;
  };
}
```

**`checkDatabase()`**
- Runs `SELECT 1` via TypeORM `DataSource.query()`.
- Returns `{ status: 'ok' }` on success, `{ status: 'error', detail: err.message }` on failure.

**`checkRedis()`**
- If `REDIS_URL` env var is not set, return `{ status: 'skip' }`.
- Otherwise call `PING` via the existing `ioredis` client (inject from `AskCacheService` or create a one-shot client).
- Returns `{ status: 'ok' }` or `{ status: 'error', detail: err.message }`.

**`checkLlm()`**
- Calls `LlmConfigDbService.getConfig(LLM_SQL_PROVIDER)` — succeeds if at least one encrypted key row exists.
- Returns `{ status: 'ok' }` if a config is returned, `{ status: 'error', detail: 'no active key' }` otherwise.

**Status aggregation logic:**
```
all ok              → 'ok'
any error           → 'error'
some skip (Redis)   → aggregate over non-skip checks only
```

**Edit: `src/db-qa/db-qa.module.ts`**
- Register `HealthService` as a provider.

---

### Step 2 — Update DbQaController

**Edit: `src/db-qa/db-qa.controller.ts`**

Replace the static `health()` handler with one that calls `HealthService.getReport()` and sets the HTTP status accordingly.

```typescript
@Get('health')
async health(@Res({ passthrough: true }) res: Response) {
  const report = await this.health.getReport();
  if (report.status === 'error') {
    res.status(HttpStatus.SERVICE_UNAVAILABLE);
  }
  return report;
}
```

- Inject `HealthService` into the controller constructor.
- `status: 'degraded'` and `status: 'ok'` both return `HTTP 200` — only `error` returns `503`.

---

### Step 3 — Dev verification checklist

After all code changes, verify on the development environment:

- [x] `GET /health` returns `200` with `status: 'ok'` when all deps are up
- [x] All three check keys (`database`, `redis`, `llm`) appear in the response
- [x] Redis check shows `{ status: 'skip' }` when `REDIS_URL` is not set
- [ ] Simulating a DB outage (e.g. wrong `DB_HOST`) causes `503` with `status: 'error'`
- [x] `POST /ask` is unaffected by the change

---

## Released: v0.2.0 — Prompt & Schema Management

Full design spec: [`DOCS/features/PROMPT_SCHEMA_MANAGEMENT.md`](features/PROMPT_SCHEMA_MANAGEMENT.md)

**Summary of changes:**
- System prompts moved from hardcoded strings to a `prompt_templates` DB table — editable at runtime via admin API
- Schema definition moved to `schema_definitions` DB table with file storage fallback (bind mount for Docker Swarm, S3 for Kubernetes)
- Admin API endpoints for prompt management and AI usage analytics
- `ai_usage_log` linked to the exact prompt version that produced each query
- `AdminGuard` for role-based access (`ADMIN` / `SUPER_ADMIN` only)

---

## Development Plan — v0.2.0

### Step 1 — Entities

Create two new TypeORM entities. TypeORM auto-sync (`synchronize: true` in non-prod) will create the tables on next startup — no manual migration needed in development.

**New file: `src/db-qa/entities/prompt-template.entity.ts`**
- Columns: `id`, `prompt_key`, `version`, `content`, `description`, `is_active`, `created_by`, `created_at`, `updated_at`
- Unique constraint on `(prompt_key, version)`
- No unique constraint on `prompt_key` alone — multiple versions per key are expected

**New file: `src/db-qa/entities/schema-definition.entity.ts`**
- Columns: `id`, `version`, `content` (jsonb), `description`, `is_active`, `created_at`, `updated_at`
- Unique constraint on `version`

**Edit: `src/app.module.ts`**
- Add `PromptTemplateEntity` and `SchemaDefinitionEntity` to the TypeORM `entities` array

**Edit: `src/db-qa/db-qa.module.ts`**
- Register the two new entities (needed before adding services that depend on them)

---

### Step 2 — AdminGuard

**New file: `src/db-qa/admin.guard.ts`**

Extends JWT validation with a role check. Reads `request.user.data.role` (pg-middleware tokens wrap the payload as `{ data: { id, role, ... } }`).

```typescript
// Logic
const role = request.user?.data?.role;
if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
  throw new ForbiddenException('Admin access required');
}
```

Allowed roles: `ADMIN`, `SUPER_ADMIN`.

> Note: `AdminGuard` does NOT call `JwtService.verifyAsync()` itself — it must be chained after `JwtAuthGuard`, or re-implement the verify + role check in one guard. Prefer a single combined guard to avoid double verification overhead.

---

### Step 3 — PromptTemplateService

**New file: `src/db-qa/prompt-template.service.ts`**

| Method | Description |
|---|---|
| `getActive(key: string)` | Returns active prompt content for a key. Loads from DB, caches in-process for 5 minutes (same TTL pattern as `LlmConfigDbService`). Throws `NotFoundException` if no active prompt exists for the key. |
| `getActiveWithId(key: string)` | Same as `getActive` but returns `{ id: number, content: string }` so `DbQaAgentService` can record the prompt version id in the usage log. |
| `renderContent(content: string, vars: Record<string, string>)` | Replaces `{{key}}` placeholders in the content string. |
| `invalidateCache()` | Clears the in-memory prompt map — called after any admin creates or activates a version. |
| `createVersion(dto)` | Inserts a new prompt version: reads current max version for the key, sets `version = max + 1`, inserts with `is_active = true`, deactivates all previous rows for that key, calls `invalidateCache()`. Wrapped in a DB transaction. |
| `activateVersion(id: number)` | Activates a specific row and deactivates all others for the same key. Wrapped in a DB transaction. Calls `invalidateCache()`. |
| `listAll()` | Returns all rows from `prompt_templates`, ordered by `prompt_key`, then `version` desc. |
| `listByKey(key: string)` | Returns all versions for a specific `prompt_key`. |

Cache structure:
```typescript
private cache: Map<string, { id: number; content: string }> = new Map();
private cacheLoadedAt = 0;
private readonly CACHE_TTL_MS = 5 * 60 * 1000;
```

**Edit: `src/db-qa/db-qa.module.ts`**
- Register `PromptTemplateService` as a provider

---

### Step 4 — StorageService

**New file: `src/db-qa/storage.service.ts`**

Abstracts file reads behind a single interface. The backend is selected by `STORAGE_BACKEND` env var at module init.

```typescript
interface IStorageBackend {
  readFile(pathOrKey: string): Promise<string>;
}
```

**`LocalStorageBackend`** — uses `fs/promises.readFile`. Path must be absolute (the bind-mounted volume path set via `SCHEMA_PATH`).

**`S3StorageBackend`** — uses `@aws-sdk/client-s3` (`GetObjectCommand`). Reads `S3_BUCKET` and uses `pathOrKey` as the S3 object key. Credentials via `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` env vars, or omitted for IAM role / IRSA on EKS.

`StorageService` exposes a single `readFile(pathOrKey: string): Promise<string>` method that delegates to the active backend.

**Edit: `package.json`**
- Add `@aws-sdk/client-s3` to production dependencies

**Edit: `.env.example`**
- Add: `STORAGE_BACKEND`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`

**Edit: `src/db-qa/db-qa.module.ts`**
- Register `StorageService` as a provider

---

### Step 5 — Update SchemaService

**Edit: `src/db-qa/schema.service.ts`**

Three changes:

1. **Inject dependencies** — add `DataSource` (TypeORM) and `StorageService`

2. **Add TTL cache** — replace the permanent `this.schema` cache with a timestamped one:
   ```typescript
   private schema: SchemaDefinition | null = null;
   private schemaLoadedAt = 0;
   private readonly SCHEMA_TTL_MS = 10 * 60 * 1000; // 10 minutes
   ```

3. **Make `loadSchema()` async** with the three-source resolution order:
   ```
   1. DB: SELECT content FROM schema_definitions WHERE is_active = true
   2. StorageService.readFile(SCHEMA_PATH env var)
   3. readFileSync(schema/SCHEMA_V1.json)  ← bundled fallback
   ```
   Each source is tried in order; the first to succeed is used. Failures are caught and logged, not thrown.

4. **Make all callers async** — `getSchemaForPrompt()`, `getSchemaForPromptFiltered()`, and `getSchemaForPromptByQuestion()` all become `async` methods that `await loadSchema()`.

---

### Step 6 — Update DbQaAgentService

**Edit: `src/db-qa/db-qa-agent.service.ts`**

- Inject `PromptTemplateService`
- Replace the hardcoded SQL generation system prompt:
  ```typescript
  // Before
  const systemPrompt = `You are a database assistant... ${schemaPrompt}`;

  // After
  const { id: promptTemplateId, content: sqlPromptContent } =
    await this.promptTemplate.getActiveWithId('sql_generation');
  const systemPrompt = this.promptTemplate.renderContent(
    sqlPromptContent, { schema: schemaPrompt }
  );
  ```
- Replace the hardcoded answer synthesis system prompt:
  ```typescript
  // Before
  systemPrompt: "You are a helpful assistant..."

  // After
  systemPrompt: await this.promptTemplate.getActive('answer_synthesis')
  ```
- Await the now-async schema call:
  ```typescript
  // Before
  const schemaPrompt = this.schemaService.getSchemaForPromptFiltered(...);

  // After
  const schemaPrompt = await this.schemaService.getSchemaForPromptFiltered(...);
  ```
- Pass `promptTemplateId` to `logUsageAsync()`

---

### Step 7 — Update AiLogsDbService and Entity

**Edit: `src/db-qa/entities/ai-usage-log.entity.ts`**
- Add column: `prompt_template_id` — `int nullable`, no FK constraint at DB level (to avoid issues if the prompts table is empty on a fresh install)

**Edit: `src/db-qa/ai-logs-db.service.ts`**
- Add `promptTemplateId?: number | null` to the `logUsage()` input type
- Include it in the INSERT

---

### Step 8 — AdminController

**New file: `src/db-qa/admin.controller.ts`**

All routes are prefixed `/admin` and protected by the combined `AdminGuard`.

| Method | Path | Handler | Description |
|---|---|---|---|
| `GET` | `/admin/prompts` | `PromptTemplateService.listAll()` | All prompt versions, all keys |
| `GET` | `/admin/prompts/:key` | `PromptTemplateService.listByKey(key)` | All versions for one key |
| `POST` | `/admin/prompts` | `PromptTemplateService.createVersion(dto)` | New version — auto-activates |
| `PATCH` | `/admin/prompts/:id/activate` | `PromptTemplateService.activateVersion(id)` | Rollback to a previous version |
| `GET` | `/admin/usage` | inline query on `ai_usage_log` | Usage stats by provider and prompt version |
| `POST` | `/admin/cache/invalidate` | `promptTemplate.invalidateCache()` + `schemaService` cache reset | Force-refresh in-memory caches |

**`POST /admin/prompts` DTO:**
```typescript
class CreatePromptDto {
  prompt_key: string;   // 'sql_generation' | 'answer_synthesis'
  content: string;      // full prompt text, may contain {{schema}}
  description?: string; // changelog note
}
```

**`GET /admin/usage` query params:** `period` (default `last_30_days`), `from`, `to`.

**Edit: `src/db-qa/db-qa.module.ts`**
- Register `AdminController`

---

### Step 9 — Module registrations

**Edit: `src/db-qa/db-qa.module.ts`**

Ensure all new providers and entities are registered:
- Providers: `PromptTemplateService`, `StorageService`
- Controllers: `AdminController`
- TypeORM entities: `PromptTemplateEntity`, `SchemaDefinitionEntity`

**Edit: `src/app.module.ts`**
- Add `PromptTemplateEntity` and `SchemaDefinitionEntity` to the root TypeORM `entities` array

---

### Step 10 — Seed scripts

**New file: `scripts/seed-prompts.js`**

Inserts or upserts the current hardcoded prompts as version 1 into `prompt_templates`. Safe to run multiple times (upsert on `prompt_key + version = 1`). Sets `is_active = true`.

Prompts to seed:
- `sql_generation` — the 11-rule SQL prompt from `db-qa-agent.service.ts` lines 111–128, with `${schemaPrompt}` replaced by `{{schema}}`
- `answer_synthesis` — the one-liner answer prompt from line 211

```bash
node scripts/seed-prompts.js
```

**New file: `scripts/seed-schema.js`**

Reads a JSON file and upserts it into `schema_definitions`. Accepts `--activate` flag to set `is_active = true` on the upserted row.

```bash
# Load v1 (default)
node scripts/seed-schema.js

# Load a new version and activate it
node scripts/seed-schema.js schema/SCHEMA_V2.json --version v2 --activate
```

---

### Step 11 — Dev verification checklist

After all code changes, verify on the development environment:

- [ ] Run `pnpm run start:dev` — no startup errors
- [ ] TypeORM auto-sync creates `prompt_templates` and `schema_definitions` tables
- [ ] Run `node scripts/seed-prompts.js` — two rows inserted, both `is_active = true`
- [ ] Run `node scripts/seed-schema.js` — one row inserted in `schema_definitions`
- [ ] `POST /ask` returns the same answer quality as before the change
- [ ] `GET /health` still returns `200`
- [ ] `GET /admin/prompts` (with admin token) returns the two seeded prompts
- [ ] `POST /admin/prompts` creates a new version and deactivates the previous one
- [ ] `PATCH /admin/prompts/:id/activate` rolls back to a previous version
- [ ] `GET /admin/usage` returns usage stats (may be empty on fresh dev DB)
- [ ] `POST /admin/cache/invalidate` returns `200` and subsequent `/ask` picks up updated prompt
- [ ] `ai_usage_log` rows have `prompt_template_id` populated after the first `/ask`
- [ ] `BYPASS_JWT_AUTH=true` still works for local dev
- [ ] Admin endpoints return `403` when called with a non-admin token

---

### Step 12 — Production migration

Before deploying v0.2.0 to production:

1. Run `node scripts/seed-prompts.js` against the production database to insert the initial prompt rows. The app will fall back to hardcoded prompts if the table is empty, but the `prompt_template_id` FK in `ai_usage_log` will be null.
2. Run `node scripts/seed-schema.js` to populate `schema_definitions` from the bundled file.
3. Deploy the new Docker image. TypeORM `synchronize` is disabled in production — the tables must already exist from step 1–2, or be created via a manual `CREATE TABLE` statement before deploying.
4. Verify `GET /health` and `POST /ask` on production after deploy.

> **Production note:** TypeORM `synchronize: false` in production means the new tables and columns (`prompt_template_id` on `ai_usage_log`) must be created manually before the new image is deployed. Prepare the DDL statements as part of the release checklist.

---

## Development Environment

**Local setup:**

```bash
pnpm install
cp .env.example .env    # fill in DB credentials, JWT_SECRET, LLM_ENCRYPTION_KEY
node scripts/seed-llm-keys.js
pnpm run start:dev
```

**Commands:**

```bash
pnpm run start:dev      # watch mode
pnpm run build          # compile TypeScript to dist/
pnpm run start:prod     # run compiled output
pnpm run test           # Jest unit tests
pnpm run test:e2e       # end-to-end tests
pnpm run lint           # ESLint + Prettier fix
```

---

## DOCS Structure

| File | Purpose |
|---|---|
| [`01_DESIGN.md`](01_DESIGN.md) | System architecture, database schema, design decisions |
| [`02_DEVELOPMENT.md`](02_DEVELOPMENT.md) | This file — release history, development plan, dev setup |
| [`03_DEPLOYMENT.md`](03_DEPLOYMENT.md) | Deployment guide — test environment, CI/CD, rollback |
| [`features/PROMPT_SCHEMA_MANAGEMENT.md`](features/PROMPT_SCHEMA_MANAGEMENT.md) | Full design spec for v0.2.0 |
