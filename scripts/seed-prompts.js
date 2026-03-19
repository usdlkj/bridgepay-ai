'use strict';

/**
 * Seed initial prompt templates into the prompt_templates table.
 *
 * Safe to run multiple times — upserts on (prompt_key, version = 1).
 * Run this once after first deployment before starting the app.
 *
 * Usage:
 *   node scripts/seed-prompts.js
 *
 * Env vars required (loaded from .env automatically):
 *   DB_AI_HOST, DB_AI_PORT, DB_AI_USERNAME, DB_AI_PASSWORD, DB_AI_DATABASE
 */

(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const { Client } = require('pg');

const SQL_GENERATION_PROMPT = `You are a database assistant for pg-middleware — KCIC's payment gateway middleware system.
Generate a single PostgreSQL SELECT query to answer the user's question about payment transactions, orders, or gateway performance.

RULES:
1. Use ONLY the tables and columns defined in the schema below.
2. All camelCase column names MUST be double-quoted: "invoiceNumber", "serviceId", "pgName", "paymentDate", etc.
3. Table names are lowercase and do NOT need quoting (orders, pg_responses, services, etc.).
4. For tables that have soft deletes, always add: WHERE "deletedAt" IS NULL (or AND "deletedAt" IS NULL).
5. Always add LIMIT 500 or lower.
6. Do NOT use query parameters ($1, $2). Write literal values directly in the SQL.
7. For relative dates use PostgreSQL interval syntax: NOW() - INTERVAL '7 days'.
8. To look up an order by invoice number: WHERE "invoiceNumber" = 'INV-XXXX'.
9. Return ONLY the raw SQL query. No explanation. No markdown fences. No comments.
10. The field "invoiceNumber" may look like '1EGA070280202820230714111849268'. Starting from the second to tenth character, this is the order number, e.g. GA07028020.
11. If user is asking for an order, reject the request unless user has order number and transaction date.

Schema:
{{schema}}`;

const ANSWER_SYNTHESIS_PROMPT = `You are a helpful assistant. Answer the user's question based on the query results. Be concise and use the data provided. If the result is empty, say so clearly.`;

const PROMPTS = [
  {
    prompt_key: 'sql_generation',
    version: 1,
    content: SQL_GENERATION_PROMPT,
    description: 'Initial SQL generation prompt — 11 rules for pg-middleware schema',
  },
  {
    prompt_key: 'answer_synthesis',
    version: 1,
    content: ANSWER_SYNTHESIS_PROMPT,
    description: 'Initial answer synthesis prompt',
  },
];

async function main() {
  const client = new Client({
    host: process.env.DB_AI_HOST ?? process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_AI_PORT ?? process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_AI_USERNAME,
    password: process.env.DB_AI_PASSWORD,
    database: process.env.DB_AI_DATABASE,
  });

  await client.connect();

  for (const p of PROMPTS) {
    await client.query(
      `INSERT INTO prompt_templates
         (prompt_key, version, content, description, is_active, created_by)
       VALUES ($1, $2, $3, $4, true, null)
       ON CONFLICT (prompt_key, version)
       DO UPDATE SET
         content     = EXCLUDED.content,
         description = EXCLUDED.description,
         updated_at  = NOW()`,
      [p.prompt_key, p.version, p.content, p.description],
    );
    console.log(`Upserted: ${p.prompt_key} v${p.version}`);
  }

  // Ensure is_active = true for version 1 of each key (in case it was deactivated)
  for (const p of PROMPTS) {
    await client.query(
      `UPDATE prompt_templates SET is_active = false
       WHERE prompt_key = $1 AND version <> 1`,
      [p.prompt_key],
    );
    await client.query(
      `UPDATE prompt_templates SET is_active = true
       WHERE prompt_key = $1 AND version = 1`,
      [p.prompt_key],
    );
  }

  await client.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
