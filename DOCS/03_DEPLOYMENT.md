# pg-middleware-ai — Deployment Guide

## Environments

| Environment | URL | Platform | Notes |
|---|---|---|---|
| Test / Dev | `https://midware-dev.kcic.co.id` | Docker Swarm VPS | Non-critical data — first target |
| Production | TBD | AWS EC2 | Requires approval gate |

---

## Prerequisites

Before the first deploy, confirm the following are in place on the target server.

### Server
- [x] Docker Engine with Swarm mode initialised — confirmed `Swarm: active`
- [x] SSH access to the Swarm manager node — `ssh -i ~/.ssh/wmstl ivan@midware-dev.kcic.co.id`
- [x] Outbound access to `docker.kcic.co.id` (private registry) — `docker login` succeeded as `kcic_it`
- [x] Reverse proxy — not required; `pg-middleware` calls `pg-middleware-ai` directly over the Swarm overlay network by service name

### Database
The service needs two PostgreSQL roles against the `pg-middleware` database:

| Role | Permissions | Purpose |
|---|---|---|
| `ai_readonly` | `CONNECT`, `SELECT` on all tables | SQL query execution |
| `ai_logs_rw` | `CONNECT`, `SELECT`, `INSERT`, `UPDATE` on AI-owned tables | Usage logging + prompt/schema management |

AI-owned tables (`ai_usage_log`, `llm_api_keys`, `prompt_templates`, `schema_definitions`) are created automatically by TypeORM on first startup (`synchronize: true` in non-prod).

Create the roles (run as a superuser against the pg-middleware DB):

```sql
-- Read-only role for query execution
CREATE ROLE ai_readonly WITH LOGIN PASSWORD 'choose_a_password';
GRANT CONNECT ON DATABASE pg_middleware TO ai_readonly;
GRANT USAGE ON SCHEMA public TO ai_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ai_readonly;

-- Read-write role for AI-owned tables
CREATE ROLE ai_logs_rw WITH LOGIN PASSWORD 'choose_a_password';
GRANT CONNECT ON DATABASE pg_middleware TO ai_logs_rw;
GRANT USAGE ON SCHEMA public TO ai_logs_rw;
-- Full access on AI-owned tables (TypeORM will create these on first boot)
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_usage_log TO ai_logs_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_api_keys TO ai_logs_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON prompt_templates TO ai_logs_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON schema_definitions TO ai_logs_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_logs_rw;
```

### Registry credentials
The server must be logged in to `docker.kcic.co.id`:
```bash
echo "<REGISTRY_PASSWORD>" | docker login docker.kcic.co.id -u "<REGISTRY_USERNAME>" --password-stdin
```

---

## Network Setup

Both `pg-middleware` and `pg-middleware-ai` must share a Docker Swarm overlay network so they can reach each other by service name without exposing ports to the host.

### Create the shared overlay network (once, on the manager node)

```bash
docker network create --driver overlay --attachable kcic_net
```

This only needs to be done once. The network persists across stack redeploys.

### Service DNS names

| Stack | Service | DNS name on `kcic_net` |
|---|---|---|
| `pgmid` | `app` | `pgmid_app` |
| `pgmai` | `app` | `pgmai_app` |

### Update `AI_SERVICE_URL` in pg-middleware

On the test server, edit `/opt/pg-middleware/.env.docker` (or wherever the pg-middleware env file lives):

```env
# Before (localhost — only works when both run on the same host without Swarm networking)
AI_SERVICE_URL=http://127.0.0.1:3001

# After (Swarm service DNS name)
AI_SERVICE_URL=http://pgmai_app:3001
```

Then redeploy the `pg-middleware` stack:

```bash
docker stack deploy -c /opt/pg-middleware/docker-compose.yml pgmid
```

---

## First-Time Server Setup

### 1. Create the directory layout

```bash
sudo mkdir -p /opt/pg-middleware-ai
sudo chown $USER:$USER /opt/pg-middleware-ai
```

### 2. Create the environment file

```bash
nano /opt/pg-middleware-ai/.env
```

Paste and fill in all values:

```env
# Database — pg-middleware (read-only queries)
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=ai_readonly
DB_PASSWORD=<ai_readonly password>
DB_DATABASE=pg_middleware

# Database — AI tables (usage logs, prompts, schema, keys)
DB_AI_USERNAME=ai_logs_rw
DB_AI_PASSWORD=<ai_logs_rw password>
DB_AI_DATABASE=pg_middleware

# JWT — must match pg-middleware LOGIN_SECRET
JWT_SECRET=<same value as pg-middleware LOGIN_SECRET>

# LLM key encryption — 64 hex chars (AES-256-GCM)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
LLM_ENCRYPTION_KEY=<64 hex chars>

# LLM providers
LLM_SQL_PROVIDER=openai
LLM_SQL_MODEL=gpt-4o
LLM_ANSWER_PROVIDER=openai
LLM_ANSWER_MODEL=gpt-4o

# Schema storage (use bundled file for test env)
STORAGE_BACKEND=local
SCHEMA_PATH=schema/SCHEMA_V1.json

# Redis (optional — omit to disable cache)
# REDIS_URL=redis://localhost:6379

# Dev override — set true to skip JWT validation during testing
BYPASS_JWT_AUTH=false
```

> **Security note:** `chmod 600 /opt/pg-middleware-ai/.env` after saving.

### 3. Copy the stack file

Either copy `docker-stack.yml` from the repo to the server, or pull it directly:

```bash
# From your local machine
scp docker-stack.yml <user>@<server>:/opt/pg-middleware-ai/docker-stack.yml

# Or on the server, paste the contents of docker-stack.yml from the repo
nano /opt/pg-middleware-ai/docker-stack.yml
```

---

## First Deploy

### 1. Pull the image

```bash
docker pull docker.kcic.co.id/bridgepay-ai:staging
```

### 2. Deploy the stack

`docker stack deploy` does not support `env_file` directly — source the env file into the shell first so `${VAR}` substitutions in the stack file are resolved:

```bash
cd /opt/pg-middleware-ai
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml pgmai
```

Verify the service starts:
```bash
docker service ls
docker service logs pgmai_app --follow
```

Wait for the log line:
```
{"level":"info","message":"NestJS application is running on port 3001"}
```

### 3. Run seed scripts

These must be run once against the database. The easiest way is to exec into the running container:

```bash
CONTAINER=$(docker ps -qf "name=pgmai_app")

# Seed LLM API keys (interactive — prompts for plaintext keys)
docker exec -it $CONTAINER node scripts/seed-llm-keys.js

# Seed default prompt templates (sql_generation, answer_synthesis)
docker exec -it $CONTAINER node scripts/seed-prompts.js

# Seed schema definition from bundled SCHEMA_V1.json
docker exec -it $CONTAINER node scripts/seed-schema.js
```

> If the scripts are not bundled in the image, run them from a local checkout pointing at the test DB:
> ```bash
> DB_HOST=midware-dev.kcic.co.id DB_AI_USERNAME=ai_logs_rw ... node scripts/seed-llm-keys.js
> ```

---

## Smoke Test

`pg-middleware-ai` is not exposed to the internet — it is internal to the Swarm network. Test from the server itself.

```bash
# 1. Health — all deps green (call directly on the host port)
curl http://localhost:3001/health

# Expected:
# {"status":"ok","service":"pg-middleware-ai","timestamp":"...","checks":{"database":{"status":"ok"},"redis":{"status":"skip"},"llm":{"status":"ok"}}}

# 2. POST /ask — test via pg-middleware (which proxies to pg-middleware-ai)
#    Use a valid session token from the back-office login
curl -X POST https://midware-dev.kcic.co.id/bo/ai/ask \
  -H "Cookie: <session cookie from browser>" \
  -H "Content-Type: application/json" \
  -d '{"question":"How many orders were placed today?"}'
```

> The health endpoint can also be called from within the Swarm network using the service DNS name: `curl http://pgmai_app:3001/health`

---

## Subsequent Deploys

After the first deploy, re-deploying (e.g. after a CI/CD push) updates the service in place using the `start-first` rolling update strategy defined in the stack file:

```bash
cd /opt/pg-middleware-ai
set -a && source .env && set +a
IMAGE_TAG=<new-sha-tag> docker stack deploy -c docker-stack.yml pgmai
```

Or to pull and redeploy the latest `:staging` tag:

```bash
docker pull docker.kcic.co.id/bridgepay-ai:staging
set -a && source /opt/pg-middleware-ai/.env && set +a
docker stack deploy -c /opt/pg-middleware-ai/docker-stack.yml pgmai
```

---

## CI/CD Integration

The current `deploy-staging` job in `.github/workflows/docker-image.yml` uses `docker stop/rm/run`. Update it to use `docker stack deploy` for Swarm compatibility.

**Replace** the `SSH deploy to staging VPS` step script with:

```bash
set -e
IMAGE="${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.build.outputs.sha_tag }}"

echo "${{ secrets.REGISTRY_PASSWORD }}" \
  | docker login ${{ env.REGISTRY }} \
      -u "${{ secrets.REGISTRY_USERNAME }}" --password-stdin

docker pull "${IMAGE}"

cd /opt/pg-middleware-ai
set -a && source .env && set +a
IMAGE_TAG="${{ needs.build.outputs.sha_tag }}" \
  docker stack deploy -c docker-stack.yml pgmai --with-registry-auth

docker image prune -f --filter "until=24h"
echo "Staging deploy complete: ${IMAGE}"
```

> `--with-registry-auth` is required so Swarm worker nodes can pull from the private registry.

---

## Rollback

### Automatic rollback
The stack is configured with `failure_action: rollback` — if the new container fails its healthcheck after deployment, Swarm automatically rolls back to the previous task.

### Manual rollback
```bash
# Roll back to the previous task version
docker service rollback pgmai_app

# Or redeploy a specific image tag
cd /opt/pg-middleware-ai
set -a && source .env && set +a
IMAGE_TAG=<previous-sha> docker stack deploy -c docker-stack.yml pgmai
```

---

## Teardown

To remove the service from the Swarm (data in the database is unaffected):

```bash
docker stack rm pgmai
```

