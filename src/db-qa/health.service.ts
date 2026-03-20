import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AskCacheService } from './ask-cache.service';
import { LlmConfigDbService } from '../llm/llm-config-db.service';

export interface CheckResult {
  status: 'ok' | 'error' | 'skip';
  detail?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  timestamp: string;
  checks: {
    database: CheckResult;
    redis: CheckResult;
    llm: CheckResult;
  };
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: AskCacheService,
    private readonly llmConfig: LlmConfigDbService,
    private readonly config: ConfigService,
  ) {}

  async getReport(): Promise<HealthReport> {
    const [database, redis, llm] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkLlm(),
    ]);

    const checks = { database, redis, llm };
    const errorChecks = [database, llm].filter((c) => c.status === 'error');
    const status = errorChecks.length > 0 ? 'error' : 'ok';

    return {
      status,
      service: 'pg-middleware-ai',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async checkDatabase(): Promise<CheckResult> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }

  private async checkRedis(): Promise<CheckResult> {
    const result = await this.cache.ping();
    if (result === 'skip') return { status: 'skip' };
    if (result === 'ok') return { status: 'ok' };
    return { status: 'error', detail: result };
  }

  private async checkLlm(): Promise<CheckResult> {
    const provider =
      this.config.get<string>('LLM_SQL_PROVIDER') ?? 'openai';
    try {
      await this.llmConfig.getConfig(provider);
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        detail: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }
}
