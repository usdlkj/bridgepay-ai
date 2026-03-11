import { Module } from '@nestjs/common';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenaiAdapter } from './adapters/openai.adapter';
import { QwenAdapter } from './adapters/qwen.adapter';
import { OllamaAdapter } from './adapters/ollama.adapter';
import { LlmResolverService } from './llm-resolver.service';

@Module({
  providers: [
    AnthropicAdapter,
    OpenaiAdapter,
    QwenAdapter,
    OllamaAdapter,
    LlmResolverService,
  ],
  exports: [LlmResolverService],
})
export class LlmModule {}
