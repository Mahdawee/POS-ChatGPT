import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Response } from "express";

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
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "خطای داخلی سرور؛ جزئیات در فایل api.log ثبت شد.";

    // Structural view of the error for Prisma duck-typing.
    const shape = exception as { name?: unknown; code?: unknown } | null | undefined;
    const name = typeof shape?.name === "string" ? shape.name : "";
    const code = typeof shape?.code === "string" ? shape.code : "";
    const isKnownPrisma = exception instanceof Prisma.PrismaClientKnownRequestError || (name === "PrismaClientKnownRequestError" && /^P\d{4}$/.test(code));
    const isPrismaValidation = exception instanceof Prisma.PrismaClientValidationError || name === "PrismaClientValidationError";
    const isPrismaInit = exception instanceof Prisma.PrismaClientInitializationError || name === "PrismaClientInitializationError";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? exception.message);
    } else if (isKnownPrisma) {
      if (code === "P2025") {
        // Record not found: a stale screen tried to update/delete something
        // that no longer exists (double submit, archived elsewhere, …).
        status = HttpStatus.BAD_REQUEST;
        message = "این رکورد پیدا نشد؛ فهرست را تازه کنید و دوباره امتحان کنید.";
      } else if (code === "P2002") {
        status = HttpStatus.BAD_REQUEST;
        message = "این مقدار تکراری است (بارکد، کد کالا یا نام کاربری).";
      } else if (code === "P2003") {
        status = HttpStatus.BAD_REQUEST;
        message = "این رکورد به اطلاعات دیگری وابسته است و قابل حذف نیست.";
      } else if (code === "P2004") {
        status = HttpStatus.BAD_REQUEST;
        message = "عملیات روی دیتابیس مجاز نیست.";
      } else if (code === "P2028") {
        // Large invoices/purchases on a slow disk can exceed the default
        // interactive-transaction window; asking for a retry is correct.
        status = HttpStatus.SERVICE_UNAVAILABLE;
        message = "سرور موقتاً مشغول است؛ چند لحظه بعد دوباره تلاش کنید.";
      } else if (code === "P2024") {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        message = "اتصال به دیتابیس محلی برقرار نشد.";
      }
    } else if (isPrismaValidation) {
      status = HttpStatus.BAD_REQUEST;
      message = "درخواست ارسال‌شده معتبر نیست.";
    } else if (isPrismaInit) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "اتصال به دیتابیس محلی برقرار نشد.";
    }

    if (status >= 500) {
      // Short reference code: the cashier can read it out over the phone and
      // it links the on-screen message to the matching stack in api.log.
      const reference = `E${Date.now().toString(36).toUpperCase().slice(-5)}`;
      if (typeof message === "string") message = `${message} (کد ${reference})`;
      // Full detail goes to the log file; the client only sees a short line.
      console.error(`[unhandled ${reference}]`, exception);
    }
    response.status(status).json({ statusCode: status, message });
  }
}
