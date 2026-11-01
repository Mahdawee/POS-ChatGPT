import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureLocalStorage } from "./storage";

async function bootstrap() {
  const dataDir = configureLocalStorage();
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  app.setGlobalPrefix("api");
  app.enableCors({ origin: ["http://127.0.0.1:1420", "http://localhost:1420", "http://tauri.localhost", "https://tauri.localhost"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  const port = Number(process.env.API_PORT || 4317);
  await app.listen(port, "127.0.0.1");
  console.log(`Dar POS API listening on 127.0.0.1:${port}; local data: ${dataDir}`);
}

bootstrap();
