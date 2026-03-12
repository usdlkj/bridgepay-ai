import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';
import { LlmConfigDbService } from '../llm-config-db.service';

@Injectable()
export class AnthropicAdapter implements LlmProvider {
  readonly providerCode = 'anthropic';
  private client: Anthropic | null = null;
  private cachedKey: string | null = null;

  constructor(private readonly configDb: LlmConfigDbService) {}

  async complete(
    messages: LlmMessage[],
    model: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const { apiKey } = await this.configDb.getConfig('anthropic');
    if (!apiKey) throw new Error('Anthropic API key not configured in llm_api_keys');

    if (apiKey !== this.cachedKey) {
      this.client = new Anthropic({ apiKey });
      this.cachedKey = apiKey;
    }

    const systemContent = options?.systemPrompt ?? '';
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client!.messages.create({
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
