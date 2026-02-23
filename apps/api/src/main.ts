import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Use built-in NestJS logger across all modules
    logger: ['log', 'warn', 'error', 'debug'],
  });

  const logger = new Logger('Bootstrap');

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Enable CORS for the frontend
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });

  // Validate all incoming request DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  // Log every incoming request and its response time
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Return structured error responses
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Swagger / OpenAPI ────────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Heist Duel API')
    .setDescription(
      'Backend API for Heist Duel — a turn-based ZK stealth game on Stellar Soroban.\n\n' +
      'Handles lobby management, on-chain transaction orchestration, Groth16 proof generation, ' +
      'and runtime configuration for the frontend.\n\n' +
      '**Endpoints overview:**\n' +
      '- `/api/lobby` — game lifecycle (create, join, SSE stream, ZK relay, on-chain actions)\n' +
      '- `/api/proof` — Groth16 proof generation (snarkjs / BN254)\n' +
      '- `/api/config` — public runtime configuration (contract IDs, network)',
    )
    .setVersion('1.0')
    .addTag('Lobby', 'Game lobby lifecycle and on-chain transaction orchestration')
    .addTag('Proof', 'Groth16 ZK proof generation (BN254 / snarkjs)')
    .addTag('Config', 'Public runtime configuration for the frontend')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
    },
    customSiteTitle: 'Heist Duel API Docs',
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);

  logger.log(`Heist Duel API running on port ${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
