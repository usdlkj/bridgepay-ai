# Feature Design: Prompt & Schema Management

## 1. Problem

Both the system prompts and the database schema definition are currently hardcoded or bundled inside the repository:

| Asset | Current location | Problem |
|---|---|---|
| SQL generation prompt | `db-qa-agent.service.ts` lines 111–128 | Changing a prompt rule requires a code edit, build, and redeploy |
| Answer synthesis prompt | `db-qa-agent.service.ts` line 211 | Same — any wording change is a deployment |
| Schema definition | `schema/SCHEMA_V1.json` on disk | File must be updated in the repo and redeployed when pg-middleware schema changes |

This makes prompt tuning (a frequent activity when improving LLM behaviour) unnecessarily expensive and couples schema evolution to application deployments.

---

## 2. Goals

- Allow system prompts to be edited at runtime via an admin API without code changes or redeployment.
- Allow the schema definition to be updated via file storage (bind mount or S3) or DB without a code deployment.
- Keep a full version history of prompts and link each query log entry to the exact prompt version that produced it.
- Expose admin-only endpoints for prompt management and usage analytics.
- Maintain performance — no extra DB round-trips on the hot path by using in-memory caching.

---

## 3. Roles & Authentication

pg-middleware has four user roles: `SUPER_ADMIN`, `ADMIN`, `TKT_MGR`, and `TICKETING`.

Tokens are issued by pg-middleware's `global.token(payload)` helper, which wraps the payload as `{ data: payload }`. The pg-middleware-ai JWT guard already decodes and attaches this as `request.user`.

When pg-middleware adds the AI page to its backoffice, it must generate a short-lived JWT containing the user's role in the payload before calling pg-middleware-ai:

```json
{ "data": { "id": 5, "role": "ADMIN", "name": "..." } }
```

### New guard: `AdminGuard`

Located at `src/db-qa/admin.guard.ts`. Extends the JWT validation with a role check:

```typescript
const role = request.user?.data?.role;
if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
  throw new ForbiddenException('Admin access required');
}
```

---

## 4. System Prompts → `prompt_templates` DB table

### 4.1 Table: `prompt_templates`

Append-only — old versions are never deleted, only deactivated.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | auto-increment |
| `prompt_key` | varchar(100) | e.g. `sql_generation`, `answer_synthesis` |
| `version` | int | Monotonically increasing per key |
| `content` | text | Prompt text. Supports `{{schema}}` placeholder (see §4.2) |
| `description` | varchar(500) nullable | Changelog note for this version |
| `is_active` | boolean | Exactly one row per `prompt_key` should be active at a time |
| `created_by` | int nullable | FK to pg-middleware user id (who created this version) |
| `created_at` | timestamp | Auto |
| `updated_at` | timestamp | Auto |

**Constraints:**
- `UNIQUE (prompt_key, version)`
- Partial unique index on `(prompt_key) WHERE is_active = true` — enforced in application logic on activation (PostgreSQL partial unique index)

### 4.2 Template variable substitution

Prompts stored in the DB use `{{schema}}` as a placeholder. At request time, `PromptTemplateService.render()` replaces it with the output of `SchemaService.getSchemaForPromptFiltered(...)`. The schema text is never stored in the DB itself.

Example stored content:

```
You are a database assistant for pg-middleware — KCIC's payment gateway middleware system.
Generate a single PostgreSQL SELECT query to answer the user's question.

RULES:
1. Use ONLY the tables and columns defined in the schema below.
...

Schema:
{{schema}}
```

### 4.3 `PromptTemplateService`

Located at `src/db-qa/prompt-template.service.ts`.

- `getActive(key)` — returns the active prompt for a key; loads from DB and caches in-process for 5 minutes.
- `render(key, vars)` — calls `getActive(key)` then replaces `{{var}}` placeholders.
- `getActiveWithId(key)` — same as `getActive` but returns `{ id, content }` so `DbQaAgentService` can record the prompt version id in the usage log.
- `invalidateCache()` — clears the in-memory cache (called after admin creates a new active version).

```
DbQaAgentService.ask()
  │
  ├── promptTemplate.getActiveWithId('sql_generation')
  │     └─ { id: 7, content: "You are..." }
  │
  ├── render content with {{schema}} substitution
  │
  └── logUsage({ promptTemplateId: 7, ... })
```

### 4.4 Changes to `DbQaAgentService`

**SQL generation:**
```typescript
// Before
const systemPrompt = `You are a database assistant... ${schemaPrompt}`;

// After
const { id: promptTemplateId, content } =
  await this.promptTemplate.getActiveWithId('sql_generation');
const systemPrompt = this.promptTemplate.renderContent(content, { schema: schemaPrompt });
```

**Answer synthesis:**
```typescript
// Before
systemPrompt: "You are a helpful assistant..."

// After
systemPrompt: await this.promptTemplate.getActive('answer_synthesis')
```

`promptTemplateId` from the SQL generation call is passed to `logUsageAsync`.

### 4.5 Changes to `ai_usage_log`

New column:

| Column | Type | Notes |
|---|---|---|
| `prompt_template_id` | int nullable | FK to `prompt_templates.id` — the active prompt version at query time |

This is nullable for backward compatibility with existing rows.

---

## 5. Value of Prompt-Version Tracking

Linking each `ai_usage_log` row to its `prompt_template_id` enables the following:

| Use case | How |
|---|---|
| **Regression detection** | After deploying a new prompt version, compare `validation_failed` and `execution_failed` counts before and after. If the new version performs worse, roll back by re-activating the previous one. |
| **Cost analysis** | Compare average `tokens_in + tokens_out` per prompt version. A more detailed prompt may improve accuracy but increase cost — the data makes this trade-off quantifiable. |
| **Quality auditing** | When a user reports a bad answer, look up the `ai_usage_log` row and see exactly which prompt rules were in effect. Reproduce the failure deterministically. |
| **Failure pattern mining** | Query `ai_usage_log WHERE status = 'validation_failed' AND prompt_template_id = X` to find the types of questions that a given prompt version fails to handle. Use this to write better rules in the next version. |
| **Latency correlation** | Shorter prompts mean less tokens to process. Track `latency_ms` per prompt version to quantify the speed/quality trade-off of prompt length. |
| **Future A/B testing** | Route a percentage of requests to a new (not-yet-active) version by passing an optional `prompt_version` override in the request, without touching the active row. Compare metrics across both groups. |

---

## 6. Schema Definition → `schema_definitions` DB table + `StorageService`

### 6.1 Table: `schema_definitions`

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | auto-increment |
| `version` | varchar(20) UNIQUE | e.g. `v1`, `v2` |
| `content` | jsonb | Full schema (same structure as current JSON file) |
| `description` | varchar(500) nullable | Changelog |
| `is_active` | boolean | Only one row active at a time |
| `created_at` | timestamp | Auto |
| `updated_at` | timestamp | Auto |

### 6.2 `StorageService` — Local file + S3 backends

A new `StorageService` (`src/db-qa/storage.service.ts`) abstracts file access behind a single interface. The backend is selected by the `STORAGE_BACKEND` env var.

```
STORAGE_BACKEND=local   → reads from SCHEMA_PATH (bind-mounted folder in Docker Swarm)
STORAGE_BACKEND=s3      → reads from S3_BUCKET / S3_KEY (AWS S3 for Kubernetes/EKS)
```

Interface:
```typescript
interface StorageService {
  readFile(path: string): Promise<string>;       // local path or S3 key
  writeFile(path: string, content: string): Promise<void>;
}
```

Adapters:
- `LocalStorageAdapter` — uses `fs/promises`. Path is absolute (bind-mounted volume).
- `S3StorageAdapter` — uses `@aws-sdk/client-s3`. Bucket and key prefix from env vars.

### 6.3 Schema resolution order in `SchemaService`

`loadSchema()` tries sources in priority order, using the first that succeeds:

```
1. DB: SELECT content FROM schema_definitions WHERE is_active = true LIMIT 1
2. StorageService.readFile(SCHEMA_PATH)    ← bind mount (Swarm) or S3 key (EKS)
3. readFileSync(schema/SCHEMA_V1.json)     ← bundled fallback (dev / fresh install)
```

**Docker Swarm setup:**
```yaml
# docker-compose.yml
volumes:
  - /data/pg-middleware-ai/schema:/app/schema-ext:ro
environment:
  STORAGE_BACKEND: local
  SCHEMA_PATH: /app/schema-ext/SCHEMA_V1.json
```
Update the file on the host to update the schema — no container restart needed (cache expires within 10 min).

**Kubernetes/EKS setup:**
```
STORAGE_BACKEND=s3
S3_BUCKET=kcic-pg-middleware-ai
S3_SCHEMA_KEY=schema/SCHEMA_V1.json
```
Upload a new JSON file to S3 to update the schema.

### 6.4 Cache TTL

`SchemaService` currently caches the schema indefinitely. The cached value will carry a `loadedAt` timestamp and be re-fetched after 10 minutes:

```typescript
private schema: SchemaDefinition | null = null;
private schemaLoadedAt = 0;
private readonly SCHEMA_TTL_MS = 10 * 60 * 1000;
```

`loadSchema()` becomes `async` — all callers in `SchemaService` and `DbQaAgentService` must be awaited.

---

## 7. Admin API

All admin endpoints require a valid JWT token where `payload.data.role` is `ADMIN` or `SUPER_ADMIN` (enforced by `AdminGuard`). All user-facing endpoints require any valid JWT (enforced by `JwtAuthGuard`).

### Endpoint list

| Method | Path | Guard | Description |
|---|---|---|---|
| `POST` | `/ask` | JwtAuthGuard | Ask AI — any logged-in user |
| `GET` | `/admin/prompts` | AdminGuard | List all prompt templates grouped by key (all versions) |
| `GET` | `/admin/prompts/:key` | AdminGuard | Get all versions for a specific prompt key |
| `POST` | `/admin/prompts` | AdminGuard | Create a new prompt version (auto-increments version, sets `is_active=true`, deactivates previous) |
| `PATCH` | `/admin/prompts/:id/activate` | AdminGuard | Activate a specific version (rollback mechanism) |
| `GET` | `/admin/usage` | AdminGuard | AI usage statistics segregated by LLM provider/model |
| `POST` | `/admin/cache/invalidate` | AdminGuard | Force-clear the in-memory prompt and schema caches |

### POST /admin/prompts

Request:
```json
{
  "prompt_key": "sql_generation",
  "content": "You are a database assistant...\n\nSchema:\n{{schema}}",
  "description": "Added rule #12 for date range queries"
}
```

Response:
```json
{
  "id": 8,
  "prompt_key": "sql_generation",
  "version": 3,
  "is_active": true,
  "created_at": "2026-03-19T10:00:00Z"
}
```

The service automatically:
1. Reads the current max `version` for the `prompt_key`.
2. Sets `version = max + 1`.
3. Inserts the new row with `is_active = true`.
4. Sets `is_active = false` on all previous rows for that key.
5. Calls `promptTemplate.invalidateCache()`.

### GET /admin/usage

Response:
```json
{
  "period": "last_30_days",
  "by_provider": [
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "total_requests": 842,
      "cache_hits": 210,
      "success_rate": 0.94,
      "avg_latency_ms": 1840,
      "total_tokens_in": 1204500,
      "total_tokens_out": 88200
    }
  ],
  "by_status": {
    "success": 596,
    "cache_hit": 210,
    "validation_failed": 22,
    "execution_failed": 8,
    "empty_sql": 6
  },
  "by_prompt_version": [
    { "prompt_key": "sql_generation", "version": 2, "requests": 300, "success_rate": 0.91 },
    { "prompt_key": "sql_generation", "version": 3, "requests": 542, "success_rate": 0.96 }
  ]
}
```

The `by_prompt_version` breakdown is only available for requests logged after this feature ships (where `prompt_template_id` is not null).

---

## 8. New Files

| File | Purpose |
|---|---|
| `src/db-qa/admin.guard.ts` | Role-based guard: allows only `ADMIN` / `SUPER_ADMIN` |
| `src/db-qa/prompt-template.service.ts` | Load, cache, and render prompt templates from DB |
| `src/db-qa/storage.service.ts` | Abstract file access (local or S3) |
| `src/db-qa/admin.controller.ts` | Admin-only endpoints (prompts, usage, cache invalidation) |
| `src/db-qa/entities/prompt-template.entity.ts` | TypeORM entity for `prompt_templates` |
| `src/db-qa/entities/schema-definition.entity.ts` | TypeORM entity for `schema_definitions` |
| `scripts/seed-prompts.js` | Seed `prompt_templates` with current hardcoded prompts |
| `scripts/seed-schema.js` | Load a JSON file into `schema_definitions` (or upload to S3) |

---

## 9. Changed Files

| File | What changes |
|---|---|
| `src/db-qa/db-qa-agent.service.ts` | Use `PromptTemplateService`; pass `promptTemplateId` to usage log |
| `src/db-qa/schema.service.ts` | Add DB + `StorageService` sources; TTL cache; `loadSchema()` becomes async |
| `src/db-qa/ai-logs-db.service.ts` | Add `prompt_template_id` to log insert |
| `src/db-qa/entities/ai-usage-log.entity.ts` | Add `prompt_template_id` column (nullable int FK) |
| `src/db-qa/db-qa.module.ts` | Register new services, entities, and admin controller |
| `src/app.module.ts` | Add new entities to TypeORM array |
| `.env.example` | Add `STORAGE_BACKEND`, `SCHEMA_PATH`, `S3_BUCKET`, `S3_SCHEMA_KEY`, `AWS_REGION` |
| `package.json` | Add `@aws-sdk/client-s3` as optional production dependency |

---

## 10. Implementation Order

1. **Entities** — `PromptTemplate`, `SchemaDefinition`. TypeORM auto-sync creates the tables.
2. **`AdminGuard`** — role check using `payload.data.role`.
3. **`PromptTemplateService`** — with DB load, in-memory cache, `render()`, `getActiveWithId()`.
4. **`StorageService`** — local and S3 adapters, selected by `STORAGE_BACKEND`.
5. **Update `SchemaService`** — DB source first, then `StorageService`, then bundled file; TTL cache; async `loadSchema()`.
6. **Update `DbQaAgentService`** — replace hardcoded prompts; await schema; pass `promptTemplateId` to usage log.
7. **Update `AiLogsDbService` + entity** — add `prompt_template_id` column.
8. **`AdminController`** — prompts CRUD, usage stats, cache invalidation.
9. **Module registrations** — `db-qa.module.ts` and `app.module.ts`.
10. **Seed scripts** — `seed-prompts.js` and `seed-schema.js`.
11. **Dev verification** — run seeds, confirm behaviour is identical to before, test admin endpoints.
12. **Production migration** — run seeds on production DB before deploying new build.

---

## 11. What Does NOT Change

- The `SchemaService` keyword-pruning logic operates on the loaded `SchemaDefinition` object — no changes needed there.
- The `schema/SCHEMA_V1.json` file stays in the repo as the bundled fallback.
- The LLM adapter layer (`llm/` module) is untouched.
- Redis-based response caching operates on the final rendered output, so cached answers are unaffected.
- The existing `POST /ask` endpoint signature and response format are unchanged.

---

## 12. Configuration Reference (additions)

| Variable | Default | Description |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `SCHEMA_PATH` | `schema/SCHEMA_V1.json` | Absolute path (local) or S3 key (s3 backend) |
| `S3_BUCKET` | — | S3 bucket name (s3 backend only) |
| `S3_REGION` | `ap-southeast-3` | AWS region |
| `S3_ACCESS_KEY_ID` | — | AWS credentials (omit if using IAM role/IRSA) |
| `S3_SECRET_ACCESS_KEY` | — | AWS credentials (omit if using IAM role/IRSA) |
