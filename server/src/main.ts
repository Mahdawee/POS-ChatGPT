import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { configureLocalStorage } from "./storage";

async function bootstrap() {
  const dataDir = configureLocalStorage();
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  app.setGlobalPrefix("api");
  // LAN mode: desktop clients on other machines connect to this API, so any
  // origin is reflected (authentication still happens per-request via JWT).
  app.enableCors({ origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.API_PORT || 4317);
  // The desktop app pins API_HOST=127.0.0.1; a machine shared as the LAN
  // server is started with API_HOST=0.0.0.0 so other registers can connect.
  const host = process.env.API_HOST || "127.0.0.1";
  await app.listen(port, host);
  console.log(`Dar POS API listening on ${host}:${port}; local data: ${dataDir}`);
}

bootstrap();
