import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';

@Injectable()
export class OpenaiAdapter implements LlmProvider {
  readonly providerCode = 'openai';
  private client: OpenAI;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
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
