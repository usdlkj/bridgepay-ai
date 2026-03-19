import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PromptTemplate } from './entities/prompt-template.entity';

export class CreatePromptDto {
  prompt_key: string;
  content: string;
  description?: string;
  created_by?: number | null;
}

/**
 * Manages prompt templates stored in the prompt_templates DB table.
 * Active prompts are cached in-process for 5 minutes to avoid DB round-trips
 * on the hot path. Call invalidateCache() after any write operation.
 */
@Injectable()
export class PromptTemplateService {
  private readonly logger = new Logger(PromptTemplateService.name);

  private cache: Map<string, { id: number; content: string }> | null = null;
  private cacheLoadedAt = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Hardcoded fallbacks used when the prompt_templates table is empty
   * (e.g. before seeds are run on a fresh install). These mirror the
   * original prompts that were hardcoded in DbQaAgentService.
   */
  private readonly FALLBACK_PROMPTS: Record<string, string> = {
    sql_generation: `You are a database assistant for pg-middleware — KCIC's payment gateway middleware system.
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
{{schema}}`,

    answer_synthesis: `You are a helpful assistant. Answer the user's question based on the query results. Be concise and use the data provided. If the result is empty, say so clearly.`,
  };

  constructor(
    @InjectRepository(PromptTemplate)
    private readonly repo: Repository<PromptTemplate>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private async loadCache(): Promise<Map<string, { id: number; content: string }>> {
    const now = Date.now();
    if (this.cache && now - this.cacheLoadedAt < this.CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      const rows = await this.repo.find({ where: { isActive: true } });
      const map = new Map<string, { id: number; content: string }>();
      for (const row of rows) {
        map.set(row.promptKey, { id: row.id, content: row.content });
      }
      this.cache = map;
      this.cacheLoadedAt = now;
      return map;
    } catch (err) {
      this.logger.warn(
        `Failed to load prompt templates from DB: ${
          err instanceof Error ? err.message : 'unknown'
        }. Using fallback.`,
      );
      return this.cache ?? new Map();
    }
  }

  /**
   * Returns { id, content } for the active prompt. Falls back to the hardcoded
   * prompt if no DB row exists. Returns id=0 for fallback rows so callers can
   * detect that the prompt is not from the DB (prompt_template_id will be null
   * in ai_usage_log for fallback prompts).
   */
  async getActiveWithId(key: string): Promise<{ id: number; content: string }> {
    const cache = await this.loadCache();
    const cached = cache.get(key);
    if (cached) return cached;

    if (key in this.FALLBACK_PROMPTS) {
      this.logger.warn(
        `No active prompt for key '${key}' in DB — using hardcoded fallback. Run seed-prompts.js to populate.`,
      );
      return { id: 0, content: this.FALLBACK_PROMPTS[key] };
    }

    throw new NotFoundException(`No active prompt found for key: ${key}`);
  }

  async getActive(key: string): Promise<string> {
    return (await this.getActiveWithId(key)).content;
  }

  /** Replace {{key}} placeholders in a prompt content string. */
  renderContent(content: string, vars: Record<string, string>): string {
    return content.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
  }

  invalidateCache(): void {
    this.cache = null;
    this.cacheLoadedAt = 0;
  }

  /**
   * Insert a new prompt version. Automatically increments version, sets it
   * active, and deactivates the previous active version — all in a transaction.
   */
  async createVersion(dto: CreatePromptDto): Promise<PromptTemplate> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const maxResult = await manager
        .createQueryBuilder(PromptTemplate, 'pt')
        .select('MAX(pt.version)', 'maxVersion')
        .where('pt.promptKey = :key', { key: dto.prompt_key })
        .getRawOne<{ maxVersion: string | null }>();

      const nextVersion = parseInt(maxResult?.maxVersion ?? '0', 10) + 1;

      await manager.update(
        PromptTemplate,
        { promptKey: dto.prompt_key, isActive: true },
        { isActive: false },
      );

      const newPrompt = manager.create(PromptTemplate, {
        promptKey: dto.prompt_key,
        version: nextVersion,
        content: dto.content,
        description: dto.description ?? null,
        isActive: true,
        createdBy: dto.created_by ?? null,
      });

      return manager.save(PromptTemplate, newPrompt);
    });

    this.invalidateCache();
    return saved;
  }

  /**
   * Activate a specific version by id, deactivating all other versions
   * for the same prompt_key. Used for rollbacks.
   */
  async activateVersion(id: number): Promise<PromptTemplate> {
    const result = await this.dataSource.transaction(async (manager) => {
      const prompt = await manager.findOne(PromptTemplate, { where: { id } });
      if (!prompt) throw new NotFoundException(`Prompt version id=${id} not found`);

      await manager.update(
        PromptTemplate,
        { promptKey: prompt.promptKey, isActive: true },
        { isActive: false },
      );
      await manager.update(PromptTemplate, { id }, { isActive: true });

      return { ...prompt, isActive: true };
    });

    this.invalidateCache();
    return result;
  }

  async listAll(): Promise<PromptTemplate[]> {
    return this.repo.find({ order: { promptKey: 'ASC', version: 'DESC' } });
  }

  async listByKey(key: string): Promise<PromptTemplate[]> {
    return this.repo.find({ where: { promptKey: key }, order: { version: 'DESC' } });
  }
}
