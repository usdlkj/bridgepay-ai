import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';
import { LlmConfigDbService } from '../llm-config-db.service';

const DEFAULT_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

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

    const resolvedBase = baseUrl ?? DEFAULT_BASE_URL;

    if (apiKey !== this.cachedKey || resolvedBase !== this.cachedBaseUrl) {
      this.client = new OpenAI({ apiKey, baseURL: resolvedBase });
      this.cachedKey = apiKey;
      this.cachedBaseUrl = resolvedBase;
    }

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const m of messages) {
      openaiMessages.push({ role: m.role, content: m.content });
    }

    const response = await this.client!.chat.completions.create({
      model,
      max_tokens: options?.maxTokens ?? 1024,
      messages: openaiMessages,
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim() ?? '';

    return {
      text,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  }
}
