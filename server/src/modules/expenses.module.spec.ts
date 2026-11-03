import { BadRequestException } from "@nestjs/common";
import { ExpensesController } from "./expenses.module";

const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };

function setup(openSession = true) {
  const tx = {
    cashSession: { findFirst: jest.fn().mockResolvedValue(openSession ? { id: "cash-1", status: "OPEN" } : null), findUnique: jest.fn().mockResolvedValue({ id: "cash-1", status: "OPEN" }) },
    expense: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "expense-1", ...data })), delete: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ id: "expense-1", title: "کرایه", amount: 500, cashSessionId: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    expense: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 500 } }) },
  };
  return { controller: new ExpensesController(prisma as never), tx };
}

describe("Expenses", () => {
  it("records a drawer-paid expense with an OUT cash movement tied to the open register", async () => {
    const { controller, tx } = setup();
    await controller.create({ title: "کرایه فروشگاه", amount: 500, fromCash: true }, user);
    expect(tx.expense.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: "کرایه فروشگاه", amount: 500, fromCash: true, cashSessionId: "cash-1", userId: user.id }) }));
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "OUT", amount: 500, cashSessionId: "cash-1" }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("keeps a non-drawer expense as bookkeeping only — no cash movement", async () => {
    const { controller, tx } = setup();
    await controller.create({ title: "قبض برق", amount: 300 }, user);
    expect(tx.expense.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fromCash: false, cashSessionId: null }) }));
    expect(tx.cashMovement.create).not.toHaveBeenCalled();
  });

  it("rejects a drawer-paid expense when no register is open", async () => {
    const { controller } = setup(false);
    await expect(controller.create({ title: "کرایه", amount: 100, fromCash: true }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("deleting a drawer expense on an open shift writes a compensating IN movement", async () => {
    const { controller, tx } = setup();
    await controller.remove("expense-1", user);
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "IN", amount: 500, cashSessionId: "cash-1" }) }));
    expect(tx.expense.delete).toHaveBeenCalledWith({ where: { id: "expense-1" } });
  });

  it("refuses to delete a drawer expense whose shift is already closed", async () => {
    const { controller, tx } = setup();
    tx.cashSession.findUnique.mockResolvedValue({ id: "cash-1", status: "CLOSED" });
    await expect(controller.remove("expense-1", user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.expense.delete).not.toHaveBeenCalled();
  });
});
