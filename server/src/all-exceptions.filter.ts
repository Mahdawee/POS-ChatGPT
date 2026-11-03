import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";

/**
 * Last line of defence for "Internal server error" pages: translates the
 * Prisma errors that bubble out of ordinary shop workflows (editing a row
 * that was deleted in another tab, saving a duplicate barcode, …) into
 * readable 400 replies, and makes sure anything truly unexpected is logged
 * with its stack to api.log instead of being swallowed.
 *
 * Prisma errors are ALSO matched structurally (name/code fields) and not
 * only via `instanceof`: the packaged runtime can end up with two copies
 * of the Prisma client module (bundling, hoisting), which would make every
 * `instanceof` check fail and turn perfectly known 400s into 500s.
 *
 * Diagnostics: every 5xx reply carries a short reference code (readable
 * over the phone, matched in api.log), the failing route is logged next to
 * it, and a compact `detail` line (exception name + route) rides along in
 * the JSON body so the cashier's screenshot already pinpoints the cause.
 */

/** Readable Dari replies per Prisma known-request error code. */
const PRISMA_MESSAGES: Record<string, { status: number; message: string }> = {
  P2002: { status: HttpStatus.BAD_REQUEST, message: "این مقدار تکراری است (بارکد، کد کالا یا نام کاربری)." },
  P2003: { status: HttpStatus.BAD_REQUEST, message: "این رکورد به اطلاعات دیگری وابسته است و قابل حذف نیست." },
  P2004: { status: HttpStatus.BAD_REQUEST, message: "عملیات روی دیتابیس مجاز نیست." },
  P2011: { status: HttpStatus.BAD_REQUEST, message: "یک مقدار لازم خالی مانده است؛ همهٔ بخش‌های الزامی را پر کنید." },
  P2012: { status: HttpStatus.BAD_REQUEST, message: "یک مقدار لازم خالی مانده است؛ همهٔ بخش‌های الزامی را پر کنید." },
  P2015: { status: HttpStatus.BAD_REQUEST, message: "این رکورد پیدا نشد؛ فهرست را تازه کنید و دوباره امتحان کنید." },
  P2016: { status: HttpStatus.BAD_REQUEST, message: "درخواست ارسال‌شده معتبر نیست." },
  P2017: { status: HttpStatus.BAD_REQUEST, message: "این رکورد به اطلاعات دیگری وابسته است و قابل حذف نیست." },
  P2018: { status: HttpStatus.BAD_REQUEST, message: "این رکورد پیدا نشد؛ فهرست را تازه کنید و دوباره امتحان کنید." },
  P2019: { status: HttpStatus.BAD_REQUEST, message: "درخواست ارسال‌شده معتبر نیست." },
  P2020: { status: HttpStatus.BAD_REQUEST, message: "یکی از اعداد واردشده از محدودهٔ مجاز بزرگ‌تر است؛ مقدار را کوچک‌تر کنید." },
  P2021: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "دیتابیس محلی با این نسخهٔ برنامه هماهنگ نیست؛ برنامه را ببندید و دوباره باز کنید." },
  P2022: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "دیتابیس محلی با این نسخهٔ برنامه هماهنگ نیست؛ برنامه را ببندید و دوباره باز کنید." },
  P2023: { status: HttpStatus.BAD_REQUEST, message: "یکی از اعداد ثبت‌شده از محدودهٔ مجاز بزرگ‌تر است؛ مقدار را کوچک‌تر کنید." },
  P2025: { status: HttpStatus.BAD_REQUEST, message: "این رکورد پیدا نشد؛ فهرست را تازه کنید و دوباره امتحان کنید." },
  // Large invoices/purchases on a slow disk can exceed the default
  // interactive-transaction window; asking for a retry is correct.
  P2028: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "سرور موقتاً مشغول است؛ چند لحظه بعد دوباره تلاش کنید." },
  P2024: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "اتصال به دیتابیس محلی برقرار نشد." },
  P2032: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "سرور موقتاً مشغول است؛ چند لحظه بعد دوباره تلاش کنید." },
  P2033: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "اتصال به دیتابیس محلی برقرار نشد." },
  P2034: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "سرور موقتاً مشغول است؛ چند لحظه بعد دوباره تلاش کنید." },
  P2035: { status: HttpStatus.BAD_REQUEST, message: "این مقدار با اطلاعات موجود سازگار نیست." },
  P2037: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "سرور موقتاً مشغول است؛ چند لحظه بعد دوباره تلاش کنید." },
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let request: { method?: string; originalUrl?: string; url?: string } | undefined;
    try {
      request = host.switchToHttp().getRequest<Request>();
    } catch { /* unit tests pass a stub host without a request */ }
    const route = `${request?.method ?? ""} ${request?.originalUrl ?? request?.url ?? ""}`.trim();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "خطای داخلی سرور؛ جزئیات در فایل api.log ثبت شد.";

    // Structural view of the error for Prisma duck-typing.
    const shape = exception as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
    const name = typeof shape?.name === "string" ? shape.name : "";
    const code = typeof shape?.code === "string" ? shape.code : "";
    const isKnownPrisma = exception instanceof Prisma.PrismaClientKnownRequestError || (name === "PrismaClientKnownRequestError" && /^P\d{4}$/.test(code));
    const isPrismaValidation = exception instanceof Prisma.PrismaClientValidationError || name === "PrismaClientValidationError";
    const isPrismaInit = exception instanceof Prisma.PrismaClientInitializationError || name === "PrismaClientInitializationError";
    const isPrismaUnknown = name === "PrismaClientUnknownRequestError";
    const isPrismaPanic = name === "PrismaClientRustPanicError";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? exception.message);
    } else if (
      // A STALE generated Prisma client (schema updated by a pull, client
      // never regenerated) makes `prisma.expense` undefined, so the first
      // model call dies with exactly this TypeError. Tell the user the
      // actionable fix instead of a scary 500.
      name === "TypeError" && /Cannot read properties of undefined \(reading '(findMany|findUnique|findFirst|create|createMany|update|updateMany|delete|deleteMany|count|aggregate|groupBy|upsert)'\)/.test(String((shape as { message?: unknown } | undefined)?.message))
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "برنامهٔ سرور به‌روزرسانی ناتمام دارد؛ یک بار برنامه را ببندید و دوباره باز کنید.";
    } else if (isKnownPrisma) {
      const mapped = PRISMA_MESSAGES[code];
      if (mapped) {
        status = mapped.status;
        message = mapped.message;
      } else {
        // An unmapped P-code is still a database-level, identified failure:
        // name the code so support can act on it without guessing.
        status = HttpStatus.BAD_REQUEST;
        message = `عملیات روی دیتابیس انجام نشد (کد ${code}).`;
      }
    } else if (isPrismaValidation) {
      status = HttpStatus.BAD_REQUEST;
      message = "درخواست ارسال‌شده معتبر نیست.";
    } else if (isPrismaInit) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "اتصال به دیتابیس محلی برقرار نشد.";
    } else if (isPrismaUnknown || isPrismaPanic) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "سرور موقتاً مشغول است؛ چند لحظه بعد دوباره تلاش کنید.";
    }

    if (status >= 500) {
      // Short reference code: the cashier can read it out over the phone and
      // it links the on-screen message to the matching stack in api.log.
      const reference = `E${Date.now().toString(36).toUpperCase().slice(-5)}`;
      if (typeof message === "string") message = `${message} (کد ${reference})`;
      // Full detail goes to the log file; the client only sees a short line.
      console.error(`[unhandled ${reference}]${route ? ` ${route}` : ""}`, exception);
      // The technical one-liner rides along in the body: it is what makes a
      // user screenshot actionable ("PrismaClientKnownRequestError … POST /api/cash/close").
      const summary = `${name || (exception as { constructor?: { name?: string } })?.constructor?.name || "Error"}: ${String((shape as { message?: unknown } | undefined)?.message ?? exception).split("\n")[0]}`.slice(0, 220);
      response.status(status).json({ statusCode: status, message, detail: route ? `${summary} — ${route}` : summary });
      return;
    }
    response.status(status).json({ statusCode: status, message });
  }
}
