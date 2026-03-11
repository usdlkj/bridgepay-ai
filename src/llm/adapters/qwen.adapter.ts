import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';

/**
 * Qwen adapter - uses Alibaba DashScope API (OpenAI-compatible).
 * Set QWEN_API_KEY and optionally QWEN_API_BASE (default: https://dashscope.aliyuncs.com/compatible-mode/v1)
 */
@Injectable()
export class QwenAdapter implements LlmProvider {
  readonly providerCode = 'qwen';
  private client: OpenAI;

  constructor(private readonly config: ConfigService) {
    const baseURL =
      this.config.get<string>('QWEN_API_BASE') ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    this.client = new OpenAI({
      apiKey: this.config.get<string>('QWEN_API_KEY'),
      baseURL,
    });
  }

  async complete(
    messages: LlmMessage[],
    model: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      openaiMessages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    for (const m of messages) {
      openaiMessages.push({
        role: m.role,
        content: m.content,
      });
    }

    const response = await this.client.chat.completions.create({
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
