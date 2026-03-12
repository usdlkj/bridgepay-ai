import { Injectable } from '@nestjs/common';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../interfaces/llm-provider.interface';
import { LlmConfigDbService } from '../llm-config-db.service';

const DEFAULT_BASE_URL = 'http://localhost:11434';

@Injectable()
export class OllamaAdapter implements LlmProvider {
  readonly providerCode = 'ollama';

  constructor(private readonly configDb: LlmConfigDbService) {}

  async complete(
    messages: LlmMessage[],
    model: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const { baseUrl } = await this.configDb.getConfig('ollama');
    const endpoint = `${baseUrl ?? DEFAULT_BASE_URL}/api/chat`;

    const ollamaMessages: { role: string; content: string }[] = [];

    if (options?.systemPrompt) {
      ollamaMessages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const m of messages) {
      ollamaMessages.push({ role: m.role, content: m.content });
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: false,
        options: { num_predict: options?.maxTokens ?? 1024 },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${err}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      text: data.message?.content?.trim() ?? '',
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
    };
  }
}
