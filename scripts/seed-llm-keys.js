/**
 * Seed / upsert LLM API keys into the llm_api_keys table.
 *
 * Usage:
 *   node scripts/seed-llm-keys.js
 *
 * Set these env vars before running (or fill PLAIN_KEYS below for a one-off):
 *   LLM_ENCRYPTION_KEY   — same 64-char hex key used by the app
 *   DB_AI_HOST / DB_AI_PORT / DB_AI_USERNAME / DB_AI_PASSWORD / DB_AI_DATABASE
 *
 * The script will INSERT or UPDATE each row (upsert on provider_code).
 */

'use strict';

// Load .env without requiring the dotenv package
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

const { createCipheriv, randomBytes } = require('crypto');
const { Client } = require('pg');

// ── keys to seed ─────────────────────────────────────────────────────────────
// Fill the values here, then delete this file (or don't commit it).
const PLAIN_KEYS = [
  {
    providerCode: 'anthropic',
    apiKey: process.env.ANTHROPIC_KEY ?? '',   // sk-ant-...
    baseUrl: null,
  },
  {
    providerCode: 'openai',
    apiKey: process.env.OPENAI_API_KEY ?? '',   // sk-proj-...
    baseUrl: null,
  },
  {
    providerCode: 'qwen',
    apiKey: process.env.QWEN_API_KEY ?? '',
    baseUrl: process.env.QWEN_API_BASE ?? null,
  },
  {
    providerCode: 'ollama',
    apiKey: null,                               // Ollama needs no API key
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  },
];
// ─────────────────────────────────────────────────────────────────────────────

function encryptKey(plaintext, keyBuf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('hex')).join(':');
}

async function main() {
  const rawKey = process.env.LLM_ENCRYPTION_KEY;
  if (!rawKey) {
    console.error('LLM_ENCRYPTION_KEY is not set');
    process.exit(1);
  }
  const keyBuf = Buffer.from(rawKey, 'hex');
  if (keyBuf.length !== 32) {
    console.error('LLM_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    process.exit(1);
  }

  const client = new Client({
    host: process.env.DB_AI_HOST ?? process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_AI_PORT ?? process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_AI_USERNAME,
    password: process.env.DB_AI_PASSWORD,
    database: process.env.DB_AI_DATABASE,
  });

  await client.connect();

  for (const entry of PLAIN_KEYS) {
    if (entry.apiKey === '') {
      console.log(`Skipping ${entry.providerCode} — no key provided`);
      continue;
    }

    const encryptedKey = entry.apiKey ? encryptKey(entry.apiKey, keyBuf) : null;

    await client.query(
      `INSERT INTO llm_api_keys (provider_code, api_key, base_url, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (provider_code)
       DO UPDATE SET api_key = EXCLUDED.api_key,
                     base_url = EXCLUDED.base_url,
                     updated_at = NOW()`,
      [entry.providerCode, encryptedKey, entry.baseUrl],
    );

    console.log(`Upserted: ${entry.providerCode}`);
  }

  await client.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
