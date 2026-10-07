import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.factory';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv(); // throws on a bad or unsafe configuration: fail fast, before listening
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app, { corsOrigins: env.CORS_ALLOWED_ORIGINS });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (that is often why we are here), so this goes straight to stderr.
  process.stderr.write(`Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
