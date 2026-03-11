import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

const FORBIDDEN_KEYWORDS = [
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'EXECUTE',
  'EXEC',
];

@Injectable()
export class QueryExecutorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueryExecutorService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.pool = new Pool({
      host: this.config.get<string>('DB_HOST') ?? 'localhost',
      port: parseInt(this.config.get<string>('DB_PORT') ?? '5432', 10),
      user: this.config.get<string>('DB_USERNAME'),
      password: this.config.get<string>('DB_PASSWORD'),
      database: this.config.get<string>('DB_DATABASE'),
      max: 5,
      idleTimeoutMillis: 30000,
    });
    this.pool.on('error', (err) =>
      this.logger.error(`pg pool error: ${err.message}`),
    );
    this.logger.log('QueryExecutorService: PostgreSQL pool initialised');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /**
   * Validate SQL safety before execution.
   * Returns { valid: true } or { valid: false, error: string }.
   */
  validateSql(sql: string): { valid: boolean; error?: string } {
    const upper = sql.toUpperCase();

    for (const kw of FORBIDDEN_KEYWORDS) {
      const pattern = new RegExp(`\\b${kw}\\b`);
      if (pattern.test(upper)) {
        return { valid: false, error: `Forbidden keyword: ${kw}` };
      }
    }

    if (!upper.trimStart().startsWith('SELECT')) {
      return { valid: false, error: 'Only SELECT queries are allowed' };
    }

    if (!upper.includes('LIMIT')) {
      return { valid: false, error: 'Query must include a LIMIT clause' };
    }

    return { valid: true };
  }

  /**
   * Execute a validated SELECT query against the PostgreSQL database.
   */
  async execute(
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql);
      return {
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.rowCount ?? result.rows.length,
      };
    } finally {
      client.release();
    }
  }
}
