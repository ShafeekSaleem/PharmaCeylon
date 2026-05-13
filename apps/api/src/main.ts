import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";

function parseWebOrigins(): string[] {
  const raw = process.env.WEB_ORIGINS?.trim();
  if (!raw) {
    return ["http://localhost:3000"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(logger);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.use(helmet());

  app.use(cookieParser());

  app.enableCors({
    origin: parseWebOrigins(),
    credentials: true,
    // SPA reads pc_csrf cookie and echoes it as X-CSRF-Token.
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "x-branch-id",
      "Idempotency-Key",
    ],
    exposedHeaders: [],
  });

  if (process.env.STRUCTURED_HTTP_LOG === "true") {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on("finish", () => {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          method: req.method,
          path: req.originalUrl ?? req.url,
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
        });
        process.stdout.write(`${line}\n`);
      });
      next();
    });
  }

  app.setGlobalPrefix("api/v1");

  if (process.env.OPENAPI_ENABLED !== "false") {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("PharmaCeylon API")
      .setDescription("Pilot REST contract (v1). Use Idempotency-Key on mutating money paths where documented.")
      .setVersion("1.0")
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("docs", app, document, { useGlobalPrefix: true });
  }

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Listening on http://localhost:${port}/api/v1`);
  if (process.env.OPENAPI_ENABLED !== "false") {
    logger.log(`OpenAPI UI: http://localhost:${port}/api/v1/docs`);
  }
  if (process.env.NODE_ENV !== "production") {
    logger.log(
      "Web UI runs on port 3000 (Next.js). From repo root run `npm run dev` for API+web, or in another terminal: `npm run dev -w web`.",
    );
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
