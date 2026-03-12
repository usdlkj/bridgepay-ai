import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiUsageLog } from './entities/ai-usage-log.entity';

@Injectable()
export class AiLogsDbService {
  private readonly logger = new Logger(AiLogsDbService.name);

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly repo: Repository<AiUsageLog>,
  ) {}

  /**
   * Log a Db Q&A usage event. Fire-and-forget — caller should not await.
   */
  async logUsage(params: {
    userId: number | null;
    llmProviderId?: number | null;
    question: string;
    sql?: string | null;
    rowCount?: number | null;
    latencyMs?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    status?: string;
  }): Promise<void> {
    try {
      await this.repo.save({
        userId: params.userId,
        llmProviderId: params.llmProviderId ?? null,
        question: params.question.slice(0, 2000),
        sqlText: params.sql?.slice(0, 65535) ?? null,
        rowCount: params.rowCount ?? null,
        latencyMs: params.latencyMs ?? null,
        tokensIn: params.tokensIn ?? null,
        tokensOut: params.tokensOut ?? null,
        status: params.status ?? 'success',
      });
    } catch (err) {
      this.logger.warn(
        `ai_usage_log insert failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}
