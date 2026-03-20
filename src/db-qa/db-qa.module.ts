import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmModule } from '../llm/llm.module';
import { DbQaController } from './db-qa.controller';
import { AdminController } from './admin.controller';
import { DbQaAgentService } from './db-qa-agent.service';
import { SchemaService } from './schema.service';
import { QueryExecutorService } from './query-executor.service';
import { ConversationSessionService } from './conversation-session.service';
import { AskCacheService } from './ask-cache.service';
import { AiLogsDbService } from './ai-logs-db.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { PromptTemplateService } from './prompt-template.service';
import { StorageService } from './storage.service';
import { HealthService } from './health.service';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { PromptTemplate } from './entities/prompt-template.entity';
import { SchemaDefinitionRecord } from './entities/schema-definition.entity';

@Module({
  imports: [
    LlmModule,
    TypeOrmModule.forFeature([AiUsageLog, PromptTemplate, SchemaDefinitionRecord]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [DbQaController, AdminController],
  providers: [
    DbQaAgentService,
    SchemaService,
    QueryExecutorService,
    ConversationSessionService,
    AskCacheService,
    AiLogsDbService,
    JwtAuthGuard,
    AdminGuard,
    PromptTemplateService,
    StorageService,
    HealthService,
  ],
})
export class DbQaModule {}
