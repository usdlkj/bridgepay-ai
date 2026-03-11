/**
 * LLM provider abstraction for Phase 4: Multi-LLM support.
 * All adapters (Anthropic, OpenAI, Qwen, Ollama) implement this interface.
 */
export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LlmCompletionOptions {
  systemPrompt?: string;
  maxTokens?: number;
}

export interface LlmCompletionResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export const LLM_PROVIDER = 'LLM_PROVIDER';

export interface LlmProvider {
  readonly providerCode: string;

  /**
   * Generate completion from messages.
   * Used for both SQL generation and answer synthesis.
   */
  complete(
    messages: LlmMessage[],
    model: string,
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult>;
}

export interface LlmConfig {
  provider: string;
  model: string;
}
