import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';
import { AdminGuard } from './admin.guard';
import { PromptTemplate } from './entities/prompt-template.entity';
import { PromptTemplateService, CreatePromptDto } from './prompt-template.service';
import { SchemaService } from './schema.service';

interface UsageQueryParams {
  period?: string;
  from?: string;
  to?: string;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly promptTemplate: PromptTemplateService,
    private readonly schemaService: SchemaService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ── Prompt management ───────────────────────────────────────────────────────

  @Get('prompts')
  listPrompts(): Promise<PromptTemplate[]> {
    return this.promptTemplate.listAll();
  }

  @Get('prompts/:key')
  listPromptsByKey(@Param('key') key: string): Promise<PromptTemplate[]> {
    return this.promptTemplate.listByKey(key);
  }

  @Post('prompts')
  async createPrompt(
    @Body() body: CreatePromptDto,
    @Req() req: Request,
  ): Promise<PromptTemplate> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const userId = (req as any)?.user?.data?.id as number | undefined;
    return this.promptTemplate.createVersion({ ...body, created_by: userId ?? null });
  }

  @Patch('prompts/:id/activate')
  activatePrompt(@Param('id', ParseIntPipe) id: number): Promise<PromptTemplate> {
    return this.promptTemplate.activateVersion(id);
  }

  // ── Cache management ────────────────────────────────────────────────────────

  @Post('cache/invalidate')
  invalidateCaches(): { message: string } {
    this.promptTemplate.invalidateCache();
    this.schemaService.invalidateCache();
    return { message: 'Prompt and schema caches invalidated' };
  }

  // ── Usage analytics ─────────────────────────────────────────────────────────

  @Get('usage')
  async getUsage(@Query() query: UsageQueryParams): Promise<unknown> {
    const fromDate = this.resolveFromDate(query);
    const toDate = query.to ? new Date(query.to) : new Date();
    const period = query.period ?? 'last_30_days';

    const [byProvider, byStatus, byPromptVersion] = await Promise.all([
      this.queryByProvider(fromDate, toDate),
      this.queryByStatus(fromDate, toDate),
      this.queryByPromptVersion(fromDate, toDate),
    ]);

    return {
      period,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      by_provider: byProvider,
      by_status: byStatus,
      by_prompt_version: byPromptVersion,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private resolveFromDate(query: UsageQueryParams): Date {
    if (query.from) return new Date(query.from);
    const now = new Date();
    const days =
      query.period === 'last_7_days' ? 7 : query.period === 'last_90_days' ? 90 : 30;
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }

  private async queryByProvider(from: Date, to: Date): Promise<unknown[]> {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT
         COALESCE(k.provider_code, 'unknown') AS provider,
         COUNT(*)::int                         AS total_requests,
         COUNT(*) FILTER (WHERE l.status = 'cache_hit')::int AS cache_hits,
         ROUND(
           COUNT(*) FILTER (WHERE l.status = 'success')::numeric /
           NULLIF(COUNT(*) FILTER (WHERE l.status <> 'cache_hit'), 0),
           4
         )                                     AS success_rate,
         ROUND(AVG(l.latency_ms))::int         AS avg_latency_ms,
         COALESCE(SUM(l.tokens_in), 0)::int    AS total_tokens_in,
         COALESCE(SUM(l.tokens_out), 0)::int   AS total_tokens_out
       FROM ai_usage_log l
       LEFT JOIN llm_api_keys k ON k.id = l.llm_provider_id
       WHERE l.created_at >= $1 AND l.created_at <= $2
       GROUP BY k.provider_code
       ORDER BY total_requests DESC`,
      [from, to],
    );
    return rows;
  }

  private async queryByStatus(from: Date, to: Date): Promise<Record<string, number>> {
    const rows = await this.dataSource.query<{ status: string; count: string }[]>(
      `SELECT status, COUNT(*)::int AS count
       FROM ai_usage_log
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY status`,
      [from, to],
    );
    return Object.fromEntries(rows.map((r) => [r.status, parseInt(r.count, 10)]));
  }

  private async queryByPromptVersion(from: Date, to: Date): Promise<unknown[]> {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT
         pt.prompt_key,
         pt.version,
         COUNT(*)::int AS requests,
         ROUND(
           COUNT(*) FILTER (WHERE l.status = 'success')::numeric /
           NULLIF(COUNT(*), 0),
           4
         ) AS success_rate
       FROM ai_usage_log l
       JOIN prompt_templates pt ON pt.id = l.prompt_template_id
       WHERE l.created_at >= $1 AND l.created_at <= $2
         AND l.prompt_template_id IS NOT NULL
       GROUP BY pt.prompt_key, pt.version
       ORDER BY pt.prompt_key, pt.version`,
      [from, to],
    );
    return rows;
  }
}
