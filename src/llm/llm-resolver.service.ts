import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LlmConfig,
  LlmProvider,
} from './interfaces/llm-provider.interface';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenaiAdapter } from './adapters/openai.adapter';
import { OllamaAdapter } from './adapters/ollama.adapter';
import { QwenAdapter } from './adapters/qwen.adapter';

const DEFAULT_SQL_PROVIDER = 'anthropic';
const DEFAULT_SQL_MODEL = 'claude-sonnet-4-6';
const DEFAULT_ANSWER_PROVIDER = 'anthropic';
const DEFAULT_ANSWER_MODEL = 'claude-sonnet-4-6';

@Injectable()
export class LlmResolverService {
  private readonly providers: Map<string, LlmProvider> = new Map();

  constructor(
    private readonly config: ConfigService,
    anthropic: AnthropicAdapter,
    openai: OpenaiAdapter,
    ollama: OllamaAdapter,
    qwen: QwenAdapter,
  ) {
    this.providers.set('anthropic', anthropic);
    this.providers.set('openai', openai);
    this.providers.set('ollama', ollama);
    this.providers.set('qwen', qwen);
  }

  /**
   * Get SQL generation config .
   * TODO: Look up company_llm_config from DB when tables exist.
   */
  getSqlConfig(): LlmConfig {
    return {
      provider:
        this.config.get<string>('LLM_SQL_PROVIDER') ?? DEFAULT_SQL_PROVIDER,
      model: this.config.get<string>('LLM_SQL_MODEL') ?? DEFAULT_SQL_MODEL,
    };
  }

  /**
   * Get answer synthesis config.
   * TODO: Look up company_llm_config from DB when tables exist.
   */
  getAnswerConfig(): LlmConfig {
    return {
      provider:
        this.config.get<string>('LLM_ANSWER_PROVIDER') ??
        DEFAULT_ANSWER_PROVIDER,
      model:
        this.config.get<string>('LLM_ANSWER_MODEL') ?? DEFAULT_ANSWER_MODEL,
    };
  }

  getProvider(code: string): LlmProvider {
    const provider = this.providers.get(code.toLowerCase());
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${code}`);
    }
    return provider;
  }

  async completeWithConfig(
    config: LlmConfig,
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    options?: { systemPrompt?: string; maxTokens?: number },
  ): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
    const provider = this.getProvider(config.provider);
    return provider.complete(messages, config.model, {
      systemPrompt: options?.systemPrompt,
      maxTokens: options?.maxTokens ?? 1024,
    });
  }
}
