import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenaiAdapter } from './adapters/openai.adapter';
import { QwenAdapter } from './adapters/qwen.adapter';
import { OllamaAdapter } from './adapters/ollama.adapter';
import { LlmResolverService } from './llm-resolver.service';
import { LlmCryptoService } from './llm-crypto.service';
import { LlmConfigDbService } from './llm-config-db.service';
import { LlmApiKey } from './entities/llm-api-key.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LlmApiKey])],
  providers: [
    LlmCryptoService,
    LlmConfigDbService,
    AnthropicAdapter,
    OpenaiAdapter,
    QwenAdapter,
    OllamaAdapter,
    LlmResolverService,
  ],
  exports: [LlmResolverService, LlmConfigDbService],
})
export class LlmModule {}
