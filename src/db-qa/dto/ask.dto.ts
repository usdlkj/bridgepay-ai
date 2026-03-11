export class AskDto {
  question: string;
  include_sql?: boolean;
  session_id?: string; // optional — enables multi-turn conversation
}

export class AskResult {
  answer: string;
  sql?: string;
  sources?: Record<string, unknown>[];
  rowCount?: number;
}
