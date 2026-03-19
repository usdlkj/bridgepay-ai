'use strict';

/**
 * Load a schema JSON file into the schema_definitions table.
 *
 * Safe to run multiple times — upserts on version.
 *
 * Usage:
 *   node scripts/seed-schema.js                            # loads schema/SCHEMA_V1.json as v1 (active)
 *   node scripts/seed-schema.js schema/SCHEMA_V2.json --version v2 --activate
 *   node scripts/seed-schema.js schema/SCHEMA_V1.json --version v1 --no-activate
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

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = path.resolve(__dirname, '..', 'schema', 'SCHEMA_V1.json');
  let version = 'v1';
  let activate = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) {
      version = args[++i];
    } else if (args[i] === '--activate') {
      activate = true;
    } else if (args[i] === '--no-activate') {
      activate = false;
    } else if (!args[i].startsWith('--')) {
      filePath = path.resolve(process.cwd(), args[i]);
    }
  }

  return { filePath, version, activate };
}

async function main() {
  const { filePath, version, activate } = parseArgs();

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let content;
  try {
    content = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON in ${filePath}: ${err.message}`);
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

  await client.query(
    `INSERT INTO schema_definitions (version, content, description, is_active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (version)
     DO UPDATE SET
       content    = EXCLUDED.content,
       is_active  = EXCLUDED.is_active,
       updated_at = NOW()`,
    [version, JSON.stringify(content), `Loaded from ${path.basename(filePath)}`, activate],
  );
  console.log(`Upserted schema version: ${version} (is_active=${activate})`);

  if (activate) {
    // Deactivate all other versions
    await client.query(
      `UPDATE schema_definitions SET is_active = false WHERE version <> $1`,
      [version],
    );
    console.log(`Deactivated all other schema versions`);
  }

  await client.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
