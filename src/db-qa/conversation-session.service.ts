import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface Turn {
  question: string;
  answer: string;
}

const SESSION_KEY_PREFIX = 'dbqa:session';
const SESSION_TTL_SEC = 3600; // 1 hour
const MAX_TURNS = 5;

@Injectable()
export class ConversationSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(ConversationSessionService.name);
  private redis: Redis | null = null;
  private memory: Map<string, Turn[]> = new Map();

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL');
    if (url) {
      try {
        this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
        this.redis.on('error', (err) =>
          this.logger.warn(`Redis session error: ${err.message}`),
        );
      } catch {
        this.logger.log('Session using in-memory store (no Redis)');
      }
    }
  }

  private key(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}:${sessionId}`;
  }

  async getTurns(sessionId: string): Promise<Turn[]> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.key(sessionId));
        if (!raw) return [];
        return JSON.parse(raw) as Turn[];
      } catch {
        return [];
      }
    }
    return this.memory.get(sessionId) ?? [];
  }

  async appendTurn(
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    const turns = await this.getTurns(sessionId);
    turns.push({ question, answer });
    const trimmed = turns.slice(-MAX_TURNS);

    if (this.redis) {
      try {
        await this.redis.setex(
          this.key(sessionId),
          SESSION_TTL_SEC,
          JSON.stringify(trimmed),
        );
      } catch (err) {
        this.logger.warn(
          `Session save failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    } else {
      this.memory.set(sessionId, trimmed);
    }
  }

  formatContextForPrompt(turns: Turn[]): string {
    if (turns.length === 0) return '';
    const lines = turns.map((t) => `Q: ${t.question}\nA: ${t.answer}`);
    return `Previous conversation:\n${lines.join('\n\n')}\n\nCurrent question: `;
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}
