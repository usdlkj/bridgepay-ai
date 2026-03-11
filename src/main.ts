import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  app.get(Logger).log(`pg-middleware-ai listening on port ${port}`, 'Bootstrap');
}
bootstrap();
