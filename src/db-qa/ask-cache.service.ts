import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import type { AskResult } from './db-qa-agent.service';

const CACHE_KEY_PREFIX = 'pgmid';
const DEFAULT_TTL_SEC = 3600; // 1 hour

@Injectable()
export class AskCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(AskCacheService.name);
  private redis: Redis | null = null;
  private readonly ttlSec: number;

  constructor(private readonly config: ConfigService) {
    this.ttlSec =
      parseInt(this.config.get<string>('DBQA_CACHE_TTL') ?? '', 10) ||
      DEFAULT_TTL_SEC;
    const url = this.config.get<string>('REDIS_URL');
    if (url) {
      try {
        this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
        this.redis.on('error', (err) =>
          this.logger.warn(`Redis error: ${err.message}`),
        );
      } catch {
        this.logger.warn('Redis init failed, cache disabled');
      }
    }
  }

  isEnabled(): boolean {
    return this.redis !== null;
  }

  cacheKey(question: string): string {
    const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
    const hash = createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 16);
    return `${CACHE_KEY_PREFIX}:${hash}`;
  }

  async get(question: string): Promise<AskResult | null> {
    if (!this.redis) return null;
    try {
      const key = this.cacheKey(question);
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as AskResult;
    } catch {
      return null;
    }
  }

  async set(question: string, result: AskResult): Promise<void> {
    if (!this.redis) return;
    try {
      const key = this.cacheKey(question);
      await this.redis.setex(key, this.ttlSec, JSON.stringify(result));
    } catch (err) {
      this.logger.warn(
        `Cache set failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}
