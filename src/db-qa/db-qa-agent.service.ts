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
  ) {}

  private logUsageAsync(
    userId: number | null | undefined,
    question: string,
    params: {
      llmProviderId?: number | null;
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
    // Resolve provider ID once — used in all logUsageAsync calls for this request.
    // Failures here are non-fatal; logging will simply record null.
    let llmProviderId: number | null = null;
    try {
      const providerCfg = await this.llmConfigDb.getConfig(sqlConfig.provider);
      llmProviderId = providerCfg.id;
    } catch {
      // provider not yet seeded — continue without ID
    }

    const cached = this.askCache.isEnabled()
      ? await this.askCache.get(question)
      : null;
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

    const schemaPruning =
      this.config.get<string>('SCHEMA_PRUNING_ENABLED') !== 'false';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- SchemaService type resolution in Nest DI
    const schemaPrompt = this.schemaService.getSchemaForPromptFiltered(
      'v1',
      question,
      schemaPruning,
    );
    let userContent = question;
    if (sessionId) {
      const turns = await this.conversationSession.getTurns(sessionId);
      if (turns.length > 0) {
        userContent =
          this.conversationSession.formatContextForPrompt(turns) + question;
      }
    }

    const systemPrompt = `You are a database assistant for pg-middleware — KCIC's payment gateway middleware system.
      Generate a single PostgreSQL SELECT query to answer the user's question about payment transactions, orders, or gateway performance.

      RULES:
      1. Use ONLY the tables and columns defined in the schema below.
      2. All camelCase column names MUST be double-quoted: "invoiceNumber", "serviceId", "pgName", "paymentDate", etc.
      3. Table names are lowercase and do NOT need quoting (orders, pg_responses, services, etc.).
      4. For tables that have soft deletes, always add: WHERE "deletedAt" IS NULL (or AND "deletedAt" IS NULL).
      5. Always add LIMIT 500 or lower.
      6. Do NOT use query parameters ($1, $2). Write literal values directly in the SQL.
      7. For relative dates use PostgreSQL interval syntax: NOW() - INTERVAL '7 days'.
      8. To look up an order by invoice number: WHERE "invoiceNumber" = 'INV-XXXX'.
      9. Return ONLY the raw SQL query. No explanation. No markdown fences. No comments.
      10. The field "invoiceNumber" may look like '1EGA070280202820230714111849268'. Starting from the second to tenth character, this is the order number, e.g. GA07028020.
      11. If user is asking for an order, reject the request unless user has order number and transaction date.

      Schema:
      ${schemaPrompt}`;

    const sqlResult = await this.llmResolver.completeWithConfig(
      sqlConfig,
      [{ role: 'user', content: userContent }],
      { systemPrompt, maxTokens: 1024 },
    );

    const rawSql = sqlResult.text.replace(/```sql|```/g, '').trim();
    const tokensIn = sqlResult.inputTokens ?? null;
    const tokensOut = sqlResult.outputTokens ?? null;

    if (!rawSql) {
      this.logger.warn(`LLM returned empty SQL for question: ${question}`);
      this.logUsageAsync(userId, question, {
        llmProviderId,
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
    const answerResult = await this.llmResolver.completeWithConfig(
      answerConfig,
      [
        {
          role: 'user',
          content: `Question: ${question}\n\nQuery results (${rowCount} rows):\n${JSON.stringify(rows.slice(0, 50), null, 2)}\n\nProvide a clear, concise answer.`,
        },
      ],
      {
        systemPrompt:
          "You are a helpful assistant. Answer the user's question based on the query results. Be concise and use the data provided. If the result is empty, say so clearly.",
        maxTokens: 1024,
      },
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
