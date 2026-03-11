import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  private schema: SchemaDefinition | null = null;

  constructor(private readonly config: ConfigService) {}

  loadSchema(): SchemaDefinition {
    if (this.schema) return this.schema;

    const schemaPath =
      this.config.get<string>('SCHEMA_PATH') ??
      join(process.cwd(), 'schema', 'SCHEMA_V1.json');

    const resolved = schemaPath.startsWith('/')
      ? schemaPath
      : join(process.cwd(), schemaPath);

    const raw = readFileSync(resolved, 'utf-8');
    this.schema = JSON.parse(raw) as SchemaDefinition;
    return this.schema;
  }

  /**
   * Build a schema string for the LLM system prompt.
   * Includes table descriptions, soft-delete notes, column types, and usage notes.
   */
  getSchemaForPrompt(): string {
    const def = this.loadSchema();
    const lines: string[] = [];

    for (const table of def.tables) {
      const cols = table.columns
        .map((c) => `"${c.name}" (${c.type})`)
        .join(', ');
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

  /**
   * Get schema for prompt, optionally pruned by question keywords.
   */
  getSchemaForPromptFiltered(
    _version: 'v1' | 'v2',
    question: string | null | undefined,
    pruningEnabled: boolean,
  ): string {
    if (question && pruningEnabled) {
      return this.getSchemaForPromptByQuestion(question);
    }
    return this.getSchemaForPrompt();
  }

  /**
   * Keyword-based schema pruning. Returns schema for tables relevant to the question.
   * Falls back to full schema if no matches.
   */
  getSchemaForPromptByQuestion(question: string): string {
    const def = this.loadSchema();
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
      const cols = table.columns
        .map((c) => `"${c.name}" (${c.type})`)
        .join(', ');
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
