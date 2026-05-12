import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
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

  // Parse cookies before guards run so they can read pc_access / pc_refresh / pc_csrf.
  app.use(cookieParser());

  app.enableCors({
    origin: parseWebOrigins(),
    credentials: true,
    // SPA reads pc_csrf cookie and echoes it as X-CSRF-Token.
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "x-branch-id"],
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
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Listening on http://localhost:${port}/api/v1`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
