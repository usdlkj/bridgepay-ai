import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';

@Injectable()
export class AnthropicAdapter implements LlmProvider {
  readonly providerCode = 'anthropic';
  private client: Anthropic;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_KEY'),
    });
  }

  async complete(
    messages: LlmMessage[],
    model: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const systemContent = options?.systemPrompt ?? '';
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 1024,
      system: systemContent,
      messages: anthropicMessages,
    });

    const first = response.content[0];
    const text = first?.type === 'text' ? (first.text ?? '').trim() : '';

    return {
      text,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }
}
