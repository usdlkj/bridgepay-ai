/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchemaService } from './schema.service';
import { QueryExecutorService } from './query-executor.service';
import { LlmResolverService } from '../llm/llm-resolver.service';
import { LlmConfigDbService } from '../llm/llm-config-db.service';
import { AskCacheService } from './ask-cache.service';
import { ConversationSessionService } from './conversation-session.service';
import { AiLogsDbService } from './ai-logs-db.service';
import { PromptTemplateService } from './prompt-template.service';

export interface AskResult {
  answer: string;
  sql?: string;
  sources?: Record<string, unknown>[];
  rowCount?: number;
}

@Injectable()
export class DbQaAgentService {
  private readonly logger = new Logger(DbQaAgentService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly schemaService: SchemaService,
    private readonly queryExecutor: QueryExecutorService,
    private readonly llmResolver: LlmResolverService,
    private readonly llmConfigDb: LlmConfigDbService,
    private readonly askCache: AskCacheService,
    private readonly conversationSession: ConversationSessionService,
    private readonly aiLogsDb: AiLogsDbService,
    private readonly promptTemplate: PromptTemplateService,
  ) {}

  private logUsageAsync(
    userId: number | null | undefined,
    question: string,
    params: {
      llmProviderId?: number | null;
      promptTemplateId?: number | null;
      sql?: string | null;
      rowCount?: number | null;
      latencyMs?: number | null;
      tokensIn?: number | null;
      tokensOut?: number | null;
      status?: string;
    },
  ): void {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- AiLogsDbService type resolution in Nest DI */
    const p = this.aiLogsDb.logUsage({
      userId: userId ?? null,
      question,
      ...params,
    });
    void p.catch(() => {});
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
  }

  async ask(
    question: string,
    includeSql = false,
    sessionId?: string,
    userId?: number | null,
  ): Promise<AskResult> {
    const startMs = Date.now();

    const sqlConfig = this.llmResolver.getSqlConfig();
    let llmProviderId: number | null = null;
    try {
      const providerCfg = await this.llmConfigDb.getConfig(sqlConfig.provider);
      llmProviderId = providerCfg.id;
    } catch {
      // provider not yet seeded — continue without ID
    }

    const cached = this.askCache.isEnabled() ? await this.askCache.get(question) : null;
    if (cached) {
      this.logger.log(`Cache hit for question`);
      const result = {
        ...cached,
        ...(includeSql && cached.sql && { sql: cached.sql }),
      };
      this.logUsageAsync(userId, question, {
        llmProviderId,
        rowCount: cached.rowCount,
        latencyMs: Date.now() - startMs,
        status: 'cache_hit',
      });
      return result;
    }

    const schemaPruning = this.config.get<string>('SCHEMA_PRUNING_ENABLED') !== 'false';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- SchemaService type resolution in Nest DI
    const schemaPrompt = await this.schemaService.getSchemaForPromptFiltered(
      'v1',
      question,
      schemaPruning,
    );

    let userContent = question;
    if (sessionId) {
      const turns = await this.conversationSession.getTurns(sessionId);
      if (turns.length > 0) {
        userContent = this.conversationSession.formatContextForPrompt(turns) + question;
      }
    }

    const { id: promptTemplateId, content: sqlPromptContent } =
      await this.promptTemplate.getActiveWithId('sql_generation');

    const systemPrompt = this.promptTemplate.renderContent(sqlPromptContent, {
      schema: schemaPrompt,
    });

    const sqlResult = await this.llmResolver.completeWithConfig(
      sqlConfig,
      [{ role: 'user', content: userContent }],
      { systemPrompt, maxTokens: 1024 },
    );

    const rawSql = sqlResult.text.replace(/```sql|```/g, '').trim();
    const tokensIn = sqlResult.inputTokens ?? null;
    const tokensOut = sqlResult.outputTokens ?? null;
    const resolvedPromptTemplateId = promptTemplateId > 0 ? promptTemplateId : null;

    if (!rawSql) {
      this.logger.warn(`LLM returned empty SQL for question: ${question}`);
      this.logUsageAsync(userId, question, {
        llmProviderId,
        promptTemplateId: resolvedPromptTemplateId,
        latencyMs: Date.now() - startMs,
        tokensIn,
        tokensOut,
        status: 'empty_sql',
      });
      return {
        answer:
          'I could not generate a valid SQL query for your question. Please try rephrasing.',
      };
    }

    this.logger.log(`Generated SQL: ${rawSql}`);

    const validation = this.queryExecutor.validateSql(rawSql);
    if (!validation.valid) {
      this.logger.warn(
        `SQL validation failed: ${validation.error}. SQL: ${rawSql}`,
      );
      this.logUsageAsync(userId, question, {
        llmProviderId,
        promptTemplateId: resolvedPromptTemplateId,
        sql: rawSql,
        latencyMs: Date.now() - startMs,
        tokensIn,
        tokensOut,
        status: 'validation_failed',
      });
      return {
        answer: `Query validation failed: ${validation.error}. Please try a different question.`,
        ...(includeSql && { sql: rawSql }),
      };
    }

    let rows: Record<string, unknown>[] = [];
    let rowCount = 0;

    try {
      const result = await this.queryExecutor.execute(rawSql);
      rows = result.rows;
      rowCount = result.rowCount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query execution failed';
      this.logger.warn(`Query execution failed: ${msg}. SQL: ${rawSql}`);
      this.logUsageAsync(userId, question, {
        llmProviderId,
        promptTemplateId: resolvedPromptTemplateId,
        sql: rawSql,
        latencyMs: Date.now() - startMs,
        tokensIn,
        tokensOut,
        status: 'execution_failed',
      });
      return {
        answer: `Could not execute the query: ${msg}. Please try rephrasing your question.`,
        ...(includeSql && { sql: rawSql }),
      };
    }

    const answerConfig = this.llmResolver.getAnswerConfig();
    const answerSystemPrompt = await this.promptTemplate.getActive('answer_synthesis');

    const answerResult = await this.llmResolver.completeWithConfig(
      answerConfig,
      [
        {
          role: 'user',
          content: `Question: ${question}\n\nQuery results (${rowCount} rows):\n${JSON.stringify(rows.slice(0, 50), null, 2)}\n\nProvide a clear, concise answer.`,
        },
      ],
      { systemPrompt: answerSystemPrompt, maxTokens: 1024 },
    );

    const answer = answerResult.text || 'No answer generated.';
    const totalTokensIn = (tokensIn ?? 0) + (answerResult.inputTokens ?? 0);
    const totalTokensOut = (tokensOut ?? 0) + (answerResult.outputTokens ?? 0);

    const result: AskResult = {
      answer,
      ...(includeSql && { sql: rawSql }),
      sources: rows.length > 0 ? rows.slice(0, 10) : undefined,
      rowCount,
    };

    this.logUsageAsync(userId, question, {
      llmProviderId,
      promptTemplateId: resolvedPromptTemplateId,
      sql: rawSql,
      rowCount,
      latencyMs: Date.now() - startMs,
      tokensIn: totalTokensIn > 0 ? totalTokensIn : null,
      tokensOut: totalTokensOut > 0 ? totalTokensOut : null,
      status: 'success',
    });

    if (this.askCache.isEnabled()) {
      await this.askCache.set(question, {
        answer,
        sql: rawSql,
        sources: result.sources,
        rowCount,
      });
    }

    if (sessionId) {
      await this.conversationSession.appendTurn(sessionId, question, answer);
    }

    return result;
  }
}
