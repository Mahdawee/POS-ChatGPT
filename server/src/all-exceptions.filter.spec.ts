import { BadRequestException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AllExceptionsFilter } from "./all-exceptions.filter";

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const filter = new AllExceptionsFilter();
  filter.catch(exception, { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as never);
  return { status, json };
}

describe("All-exceptions filter", () => {
  it("passes HttpExceptions (like BadRequest) through with their Dari message", () => {
    const { status, json } = run(new BadRequestException("صندوق باز وجود ندارد."));
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({ statusCode: 400, message: "صندوق باز وجود ندارد." });
  });

  it("turns Prisma record-not-found (P2025) into a readable 400 instead of a 500", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Record to update not found.", { code: "P2025", clientVersion: "test" });
    const { status, json } = run(error);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("پیدا نشد");
  });

  it("turns Prisma unique-constraint (P2002) — e.g. duplicate barcode — into a readable 400", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed.", { code: "P2002", clientVersion: "test", meta: { target: ["barcode"] } });
    const { status, json } = run(error);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("تکراری");
  });

  it("keeps unknown errors as 500 with a Dari message, a reference code and the logged details", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { status, json } = run(new Error("boom"));
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("api.log");
    expect(payload.message).toMatch(/\(کد E[0-9A-Z]+\)/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still maps a structurally-detected Prisma error (no instanceof — dual client copies) to 400", () => {
    // The packaged runtime can load the Prisma client twice; the thrown
    // error then fails `instanceof` but keeps name/code, which the filter
    // must recognize so known cases never surface as 500s.
    const duckTyped = Object.assign(new Error("Unique constraint failed"), { name: "PrismaClientKnownRequestError", code: "P2002" });
    const { status, json } = run(duckTyped);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("تکراری");
  });

  it("maps transaction timeouts (P2028) to a retryable 503 instead of a 500", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Transaction timed out.", { code: "P2028", clientVersion: "test" });
    const { status, json } = run(error);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("دوباره تلاش");
  });

  it("maps int-overflow / inconsistent-column errors (P2023 — the cash-close brick) to a readable 400", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Inconsistent column data: number too large to fit in target type", { code: "P2023", clientVersion: "test" });
    const { status, json } = run(error);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("محدودهٔ مجاز");
  });

  it("maps a missing database column (P2022 — stale local database) to a 503 with an update hint", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Column does not exist", { code: "P2022", clientVersion: "test" });
    const { status, json } = run(error);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("هماهنگ نیست");
  });

  it("never leaves an unmapped Prisma code as a bare 500: it names the code", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Something exotic", { code: "P2999", clientVersion: "test" });
    const { status, json } = run(error);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("P2999");
  });

  it("attaches a technical detail line (exception + route) to 5xx replies so screenshots pinpoint the cause", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { json } = run(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const payload = json.mock.calls[0][0] as { detail?: string };
    expect(payload.detail).toContain("TypeError");
    expect(payload.detail).toContain("Cannot read properties");
    spy.mockRestore();
  });

  it("logs the failing route next to the reference code", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    run(new Error("boom"));
    expect(spy.mock.calls[0].join(" ")).toMatch(/\[unhandled E[0-9A-Z]+\]/);
    spy.mockRestore();
  });
});
