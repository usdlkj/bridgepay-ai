import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmModule } from '../llm/llm.module';
import { DbQaController } from './db-qa.controller';
import { DbQaAgentService } from './db-qa-agent.service';
import { SchemaService } from './schema.service';
import { QueryExecutorService } from './query-executor.service';
import { ConversationSessionService } from './conversation-session.service';
import { AskCacheService } from './ask-cache.service';
import { AiLogsDbService } from './ai-logs-db.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AiUsageLog } from './entities/ai-usage-log.entity';

@Module({
  imports: [
    LlmModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host:
          config.get<string>('DB_AI_HOST') ??
          config.get<string>('DB_HOST') ??
          'localhost',
        port: parseInt(
          config.get<string>('DB_AI_PORT') ??
            config.get<string>('DB_PORT') ??
            '5432',
          10,
        ),
        username: config.get<string>('DB_AI_USERNAME'),
        password: config.get<string>('DB_AI_PASSWORD'),
        database: config.get<string>('DB_AI_DATABASE'),
        entities: [AiUsageLog],
        synchronize: true,
      }),
    }),
    TypeOrmModule.forFeature([AiUsageLog]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [DbQaController],
  providers: [
    DbQaAgentService,
    SchemaService,
    QueryExecutorService,
    ConversationSessionService,
    AskCacheService,
    AiLogsDbService,
    JwtAuthGuard,
  ],
})
export class DbQaModule {}
