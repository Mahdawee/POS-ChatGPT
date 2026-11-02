import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Response } from "express";

/**
 * Last line of defence for "Internal server error" pages: translates the
 * Prisma errors that bubble out of ordinary shop workflows (editing a row
 * that was deleted in another tab, saving a duplicate barcode, …) into
 * readable 400 replies, and makes sure anything truly unexpected is logged
 * with its stack to api.log instead of being swallowed.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "خطای داخلی سرور؛ جزئیات در فایل api.log ثبت شد.";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? exception.message);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2025") {
        // Record not found: a stale screen tried to update/delete something
        // that no longer exists (double submit, archived elsewhere, …).
        status = HttpStatus.BAD_REQUEST;
        message = "این رکورد پیدا نشد؛ فهرست را تازه کنید و دوباره امتحان کنید.";
      } else if (exception.code === "P2002") {
        status = HttpStatus.BAD_REQUEST;
        message = "این مقدار تکراری است (بارکد، کد کالا یا نام کاربری).";
      } else if (exception.code === "P2003") {
        status = HttpStatus.BAD_REQUEST;
        message = "این رکورد به اطلاعات دیگری وابسته است و قابل حذف نیست.";
      } else if (exception.code === "P2004") {
        status = HttpStatus.BAD_REQUEST;
        message = "عملیات روی دیتابیس مجاز نیست.";
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = "درخواست ارسال‌شده معتبر نیست.";
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "اتصال به دیتابیس محلی برقرار نشد.";
    }

    if (status >= 500) {
      // Full detail goes to the log file; the client only sees a short line.
      console.error("[unhandled]", exception);
    }
    response.status(status).json({ statusCode: status, message });
  }
}
