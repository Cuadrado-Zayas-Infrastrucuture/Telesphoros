import 'reflect-metadata';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.factory';
import { loadEnv } from './config/env';
import { listenerTls } from './config/listener-tls';
import { installProcessFaultHandlers } from './common/process-faults';
import { installGracefulShutdown } from './common/graceful-shutdown';

// First, so a fault during start-up or at any later point ends the process with one PHI-safe line instead of Node's default message and stack.
installProcessFaultHandlers(process, { service: 'api' });

async function bootstrap() {
  const env = loadEnv(); // throws on a bad or unsafe configuration: fail fast, before listening
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), { bufferLogs: true, httpsOptions: listenerTls(env) });
  app.useLogger(app.get(Logger));
  configureApp(app, { corsOrigins: env.CORS_ALLOWED_ORIGINS, trustProxyHops: env.TRUST_PROXY_HOPS });
  // Not app.enableShutdownHooks(): Nest closes the database pool before the listener, under requests still running. This drains the listener first.
  await app.listen(env.PORT);
  installGracefulShutdown(app, app.getHttpServer() as Server);
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (that is often why we are here), so this goes straight to stderr.
  process.stderr.write(`Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
