import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { DbQaModule } from './db-qa/db-qa.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.LOG_FORMAT !== 'json'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: ['req.headers.authorization'],
      },
    }),
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
        // Automatically registers all entities declared in forFeature() calls
        autoLoadEntities: true,
        synchronize: config.get<string>('NODE_ENV') !== 'production',
      }),
    }),
    DbQaModule,
  ],
})
export class AppModule {}
