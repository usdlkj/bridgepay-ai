import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StorageService } from './storage.service';
import { SchemaDefinitionRecord } from './entities/schema-definition.entity';

export interface SchemaColumn {
  name: string;
  type: string;
  nullable?: boolean;
  description?: string;
}

export interface SchemaTable {
  name: string;
  description?: string;
  softDelete?: boolean;
  columns: SchemaColumn[];
  usageNotes?: string;
}

export interface SchemaDefinition {
  _meta?: Record<string, string>;
  tables: SchemaTable[];
}

@Injectable()
export class SchemaService {
  private readonly logger = new Logger(SchemaService.name);

  private schema: SchemaDefinition | null = null;
  private schemaLoadedAt = 0;
  private readonly SCHEMA_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(SchemaDefinitionRecord)
    private readonly schemaRepo: Repository<SchemaDefinitionRecord>,
    private readonly storageService: StorageService,
  ) {}

  invalidateCache(): void {
    this.schema = null;
    this.schemaLoadedAt = 0;
  }

  /**
   * Load the schema definition with a 10-minute TTL cache.
   * Resolution order:
   *   1. DB: schema_definitions WHERE is_active = true
   *   2. StorageService: SCHEMA_PATH env var (bind mount or S3 key)
   *   3. Bundled fallback: schema/SCHEMA_V1.json
   */
  async loadSchema(): Promise<SchemaDefinition> {
    const now = Date.now();
    if (this.schema && now - this.schemaLoadedAt < this.SCHEMA_TTL_MS) {
      return this.schema;
    }

    // 1. DB
    try {
      const record = await this.schemaRepo.findOne({ where: { isActive: true } });
      if (record) {
        this.schema = record.content as unknown as SchemaDefinition;
        this.schemaLoadedAt = now;
        this.logger.debug('Schema loaded from DB');
        return this.schema;
      }
    } catch (err) {
      this.logger.warn(
        `DB schema load failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    // 2. StorageService (bind mount or S3)
    const schemaPath = this.config.get<string>('SCHEMA_PATH');
    if (schemaPath) {
      try {
        const raw = await this.storageService.readFile(schemaPath);
        this.schema = JSON.parse(raw) as SchemaDefinition;
        this.schemaLoadedAt = now;
        this.logger.debug(`Schema loaded from storage: ${schemaPath}`);
        return this.schema;
      } catch (err) {
        this.logger.warn(
          `Storage schema load failed (${schemaPath}): ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }
    }

    // 3. Bundled fallback
    const fallbackPath = join(process.cwd(), 'schema', 'SCHEMA_V1.json');
    const raw = readFileSync(fallbackPath, 'utf-8');
    this.schema = JSON.parse(raw) as SchemaDefinition;
    this.schemaLoadedAt = now;
    this.logger.debug('Schema loaded from bundled fallback');
    return this.schema;
  }

  /** For ENUM columns, inline the allowed values so the LLM uses exact case. */
  private formatColumn(c: SchemaColumn): string {
    if (c.description && /^enum$/i.test(c.type.split(/[\s(]/)[0])) {
      const values = (c.description.match(/'[^']+'/g) ?? []).join(', ');
      return values ? `"${c.name}" (ENUM: ${values})` : `"${c.name}" (ENUM)`;
    }
    return `"${c.name}" (${c.type})`;
  }

  async getSchemaForPrompt(): Promise<string> {
    const def = await this.loadSchema();
    const lines: string[] = [];

    for (const table of def.tables) {
      const cols = table.columns.map((c) => this.formatColumn(c)).join(', ');
      const softDeleteNote = table.softDelete
        ? ' [soft-delete: filter WHERE "deletedAt" IS NULL]'
        : '';
      const desc = table.description ? ` — ${table.description}` : '';
      lines.push(`- ${table.name}${softDeleteNote}${desc}`);
      lines.push(`  Columns: ${cols}`);
      if (table.usageNotes) {
        lines.push(`  Notes: ${table.usageNotes}`);
      }
    }

    return lines.join('\n');
  }

  async getSchemaForPromptFiltered(
    _version: 'v1' | 'v2',
    question: string | null | undefined,
    pruningEnabled: boolean,
  ): Promise<string> {
    if (question && pruningEnabled) {
      return this.getSchemaForPromptByQuestion(question);
    }
    return this.getSchemaForPrompt();
  }

  async getSchemaForPromptByQuestion(question: string): Promise<string> {
    const def = await this.loadSchema();
    const terms = question
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (terms.length === 0) return this.getSchemaForPrompt();

    const score = (table: SchemaTable): number => {
      let s = 0;
      const name = table.name.toLowerCase();
      const desc = (table.description ?? '').toLowerCase();
      const notes = (table.usageNotes ?? '').toLowerCase();
      const colNames = table.columns.map((c) => c.name.toLowerCase()).join(' ');
      for (const t of terms) {
        if (name.includes(t)) s += 3;
        if (desc.includes(t)) s += 2;
        if (notes.includes(t)) s += 1;
        if (colNames.includes(t)) s += 1;
      }
      return s;
    };

    const scored = def.tables.map((t) => ({ table: t, s: score(t) }));
    const relevant = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (relevant.length === 0) return this.getSchemaForPrompt();

    const topTables = new Set(relevant.slice(0, 8).map((x) => x.table.name));
    const tablesToInclude = def.tables.filter((t) => topTables.has(t.name));
    if (tablesToInclude.length < 2) return this.getSchemaForPrompt();

    const lines: string[] = [];
    for (const table of tablesToInclude) {
      const cols = table.columns.map((c) => this.formatColumn(c)).join(', ');
      const softDeleteNote = table.softDelete
        ? ' [soft-delete: filter WHERE "deletedAt" IS NULL]'
        : '';
      const desc = table.description ? ` — ${table.description}` : '';
      lines.push(`- ${table.name}${softDeleteNote}${desc}`);
      lines.push(`  Columns: ${cols}`);
      if (table.usageNotes) {
        lines.push(`  Notes: ${table.usageNotes}`);
      }
    }
    return lines.join('\n');
  }
}
