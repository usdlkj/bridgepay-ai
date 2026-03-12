import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmApiKey } from './entities/llm-api-key.entity';
import { LlmCryptoService } from './llm-crypto.service';

export interface LlmProviderConfig {
  apiKey: string | null;
  baseUrl: string | null;
}

interface CacheEntry {
  config: LlmProviderConfig;
  expiresAt: number;
}

/** Cache decrypted keys in-memory for 5 minutes to reduce DB load */
const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class LlmConfigDbService implements OnModuleDestroy {
  private readonly logger = new Logger(LlmConfigDbService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    @InjectRepository(LlmApiKey)
    private readonly repo: Repository<LlmApiKey>,
    private readonly crypto: LlmCryptoService,
  ) {
    this.cleanupTimer = setInterval(
      () => this.evictExpired(),
      10 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  async getConfig(providerCode: string): Promise<LlmProviderConfig> {
    const now = Date.now();
    const cached = this.cache.get(providerCode);
    if (cached && cached.expiresAt > now) {
      return cached.config;
    }

    const row = await this.repo.findOne({
      where: { providerCode, isActive: true },
    });

    if (!row) {
      throw new Error(
        `No active LLM config found for provider "${providerCode}". ` +
          'Insert a row into llm_api_keys.',
      );
    }

    const config: LlmProviderConfig = {
      apiKey: row.apiKey ? this.crypto.decrypt(row.apiKey) : null,
      baseUrl: row.baseUrl ?? null,
    };

    this.cache.set(providerCode, { config, expiresAt: now + CACHE_TTL_MS });
    this.logger.debug(`Loaded LLM config for "${providerCode}" from DB`);
    return config;
  }

  /** Force-clear cache entry so the next call reloads from DB */
  invalidate(providerCode: string) {
    this.cache.delete(providerCode);
  }

  private evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
