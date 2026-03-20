import { Injectable } from '@nestjs/common';
import OpenAI, { APIError } from 'openai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';
import { LlmConfigDbService } from '../llm-config-db.service';

const DEFAULT_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

const INTL_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

/** DashScope OpenAI-compatible path (404 if omitted from base URL). */
const COMPAT_PATH = '/compatible-mode/v1';

/**
 * After Beijing default, intl keys often get HTTP 404 (no body) on the China endpoint.
 * Swap once on 404 so users without DB base_url still work.
 */
function alternateDashScopeBaseOn404(current: string): string | null {
  try {
    const host = new URL(current).hostname.toLowerCase();
    if (host === 'dashscope.aliyuncs.com') {
      return INTL_BASE_URL;
    }
    if (host === 'dashscope-intl.aliyuncs.com') {
      return DEFAULT_BASE_URL;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve base URL from DB: empty/whitespace → default; DashScope hosts missing path → append compatible path.
 */
function resolveQwenBaseUrl(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  const noTrail = trimmed.replace(/\/+$/, '');
  try {
    const u = new URL(noTrail);
    const host = u.hostname.toLowerCase();
    const isDashScopeHost =
      host === 'dashscope.aliyuncs.com' ||
      host === 'dashscope-intl.aliyuncs.com' ||
      host === 'dashscope-us.aliyuncs.com' ||
      host.endsWith('.dashscope.aliyuncs.com');

    if (isDashScopeHost && !u.pathname.includes('compatible-mode')) {
      return `${u.origin}${COMPAT_PATH}`;
    }
  } catch {
    /* not a valid URL; return trimmed value for OpenAI client to surface */
  }
  return noTrail;
}

/**
 * Qwen adapter — Alibaba DashScope API (OpenAI-compatible).
 * base_url row in llm_api_keys: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * for international accounts if the default endpoint returns 401.
 */
@Injectable()
export class QwenAdapter implements LlmProvider {
  readonly providerCode = 'qwen';
  private client: OpenAI | null = null;
  private cachedKey: string | null = null;
  private cachedBaseUrl: string | null = null;

  constructor(private readonly configDb: LlmConfigDbService) {}

  async complete(
    messages: LlmMessage[],
    model: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const { apiKey, baseUrl } = await this.configDb.getConfig('qwen');
    if (!apiKey) throw new Error('Qwen API key not configured in llm_api_keys');

    const resolvedBase = resolveQwenBaseUrl(baseUrl);

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const m of messages) {
      openaiMessages.push({ role: m.role, content: m.content });
    }

    const params = {
      model,
      max_tokens: options?.maxTokens ?? 1024,
      messages: openaiMessages,
    };

    let base = resolvedBase;

    for (let i = 0; i < 2; i++) {
      try {
        if (
          i === 0 &&
          this.client &&
          apiKey === this.cachedKey &&
          base === this.cachedBaseUrl
        ) {
          const response = await this.client.chat.completions.create(params);
          return this.toResult(response);
        }

        const client = new OpenAI({ apiKey, baseURL: base });
        const response = await client.chat.completions.create(params);
        this.client = client;
        this.cachedKey = apiKey;
        this.cachedBaseUrl = base;
        return this.toResult(response);
      } catch (err) {
        if (
          i === 0 &&
          err instanceof APIError &&
          err.status === 404
        ) {
          const alt = alternateDashScopeBaseOn404(base);
          if (alt && alt !== base) {
            base = alt;
            continue;
          }
        }
        throw err;
      }
    }

    throw new Error('Qwen completion: unexpected retry loop exit');
  }

  private toResult(
    response: OpenAI.Chat.Completions.ChatCompletion,
  ): LlmCompletionResult {
    const choice = response.choices[0];
    const text = choice?.message?.content?.trim() ?? '';

    return {
      text,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  }
}
