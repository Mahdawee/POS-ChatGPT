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

  it("keeps unknown errors as 500 with a Dari message and logs the details", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { status, json } = run(new Error("boom"));
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).toContain("api.log");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
