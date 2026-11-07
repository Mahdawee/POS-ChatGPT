import { BadRequestException } from "@nestjs/common";
import { CustomersController, SuppliersController } from "./contacts.module";

function setup() {
  // Mojks مشترک بین tx و prisma: ثبتِ مشتری حالا داخل $transaction اجرا
  // می‌شود (کد بعدی و نوشتن در یک تراکنش) — همان mock باید از هر دو مسیر
  // دیده شود تا انتظارهای تست‌های موجود سر جایشان بمانند.
  const customerFindMany = jest.fn().mockResolvedValue([
    { id: "customer-1", name: "احمد", isActive: true },
    { id: "customer-2", name: "زبیده", isActive: true },
  ]);
  const customerCreate = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "c-new", ...data }));
  const tx = {
    customer: { findMany: customerFindMany, create: customerCreate, findUnique: jest.fn().mockResolvedValue({ id: "customer-1", name: "احمد", isActive: true }), update: jest.fn().mockResolvedValue({ walletBalance: 120 }) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    customerPayment: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "payment-1", ...data })) },
    customerWalletTxn: { create: jest.fn().mockResolvedValue({ id: "txn-1" }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    customer: {
      findMany: customerFindMany,
      create: customerCreate,
      update: jest.fn().mockResolvedValue({ id: "customer-1" }),
    },
    sale: { groupBy: jest.fn().mockResolvedValue([{ customerId: "customer-1", _sum: { creditPart: 500 } }]) },
    saleReturn: { findMany: jest.fn().mockResolvedValue([{ creditRelief: 100, sale: { customerId: "customer-1" } }]) },
    customerPayment: { groupBy: jest.fn().mockResolvedValue([{ customerId: "customer-1", _sum: { amount: 150 } }]) },
  };
  return { controller: new CustomersController(prisma as never), tx, prisma };
}

describe("Customer credit balances", () => {
  it("computes balance as credit sales minus returns minus payments per customer", async () => {
    const { controller } = setup();
    const list = (await controller.list()) as Array<{ id: string; balance: number }>;
    const ahmad = list.find((customer) => customer.id === "customer-1");
    const zubeida = list.find((customer) => customer.id === "customer-2");
    expect(ahmad?.balance).toBe(250); // 500 - 100 - 150
    expect(zubeida?.balance).toBe(0); // no credit activity
  });

  it("books a fromCash wallet charge as money INTO the drawer (Z-report stays honest)", async () => {
    const { controller, tx } = setup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    await controller.chargeWallet("customer-1", { amount: 120, fromCash: true }, user);
    // The customer hands cash over and receives credit: the drawer GAINS.
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "IN", amount: 120, cashSessionId: "cash-1" }) }));
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: "customer-1" }, data: { walletBalance: { increment: 120 } } });
  });

  it("books a repayment as cash-in on the open session inside one transaction", async () => {
    const { controller, tx } = setup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    await controller.pay("customer-1", { amount: 200, note: "قسط نخست" }, user);
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "IN", amount: 200, cashSessionId: "cash-1" }) }));
    expect(tx.customerPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: "customer-1", amount: 200, userId: user.id }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
  });
});

function supplierSetup() {
  const tx = {
    supplier: { findUnique: jest.fn().mockResolvedValue({ id: "supplier-1", name: "تأمین‌کننده نمونه", isActive: true }) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    supplierPayment: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "payment-1", ...data })) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    supplier: { findMany: jest.fn().mockResolvedValue([{ id: "supplier-1", name: "تأمین‌کننده نمونه", isActive: true }]) },
    purchase: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "supplier-1", _sum: { total: 800, paidAmount: 500 } }]) },
    supplierPayment: { groupBy: jest.fn().mockResolvedValue([{ supplierId: "supplier-1", _sum: { amount: 100 } }]) },
    purchaseReturn: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  return { controller: new SuppliersController(prisma as never), tx, prisma };
}

describe("Supplier balances", () => {
  it("computes balance as purchases minus paid-at-purchase minus later payments", async () => {
    const { controller } = supplierSetup();
    const list = (await controller.list()) as Array<{ id: string; balance: number }>;
    expect(list[0]?.balance).toBe(200); // 800 - 500 - 100
  });

  it("records a supplier payment as bookkeeping only, without touching the cash drawer", async () => {
    const { controller, tx } = supplierSetup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    await controller.pay("supplier-1", { amount: 150 }, user);
    expect(tx.supplierPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supplierId: "supplier-1", amount: 150, userId: user.id }) }));
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(tx.cashMovement.create).not.toHaveBeenCalled();
  });

  it("pays a supplier out of the open register when fromCash is set", async () => {
    const { controller, tx } = supplierSetup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    await controller.pay("supplier-1", { amount: 150, fromCash: true }, user);
    expect(tx.cashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "OUT", amount: 150, cashSessionId: "cash-1" }) }));
  });

  it("refuses a fromCash payment when no register is open", async () => {
    const { controller, tx } = supplierSetup();
    const user = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
    tx.cashSession.findFirst.mockResolvedValue(null);
    await expect(controller.pay("supplier-1", { amount: 150, fromCash: true }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.supplierPayment.create).not.toHaveBeenCalled();
  });
});

describe("کد مشتری خودکار (C-1001…)", () => {
  it("کد خالی → بزرگ‌ترین شمارهٔ موجود + ۱ ساخته می‌شود", async () => {
    const { controller, prisma } = setup();
    prisma.customer.findMany.mockResolvedValue([{ code: null }, { code: "C-1003" }]);
    const created = (await controller.create({ name: "مریم" } as never)) as { code: string };
    expect(created.code).toBe("C-1004");
    expect(prisma.customer.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: "مریم", code: "C-1004" }) }));
  });

  it("اولین مشتری بدون کد → C-1001", async () => {
    const { controller, prisma } = setup();
    prisma.customer.findMany.mockResolvedValue([]);
    const created = (await controller.create({ name: "احمد" } as never)) as { code: string };
    expect(created.code).toBe("C-1001");
  });

  it("کد دستی دست‌نخورده می‌ماند", async () => {
    const { controller, prisma } = setup();
    const created = (await controller.create({ name: "زبیده", code: "Z-1" } as never)) as { code: string };
    expect(created.code).toBe("Z-1");
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it("دو ثبتِ همزمان با یک کد → تلاشِ دوباره کدِ تازه می‌گیرد (P2002)", async () => {
    const { controller, tx } = setup();
    // تلاش اول همان C-1004 را می‌سازد که ثبتِ همزمانِ دیگری برداشته —
    // قید یکتا نوشتن را رد می‌کند؛ تلاش دوم بزرگ‌ترین شمارهٔ «الان-موجود»
    // را می‌خواند و یکی جلوتر می‌رود.
    tx.customer.findMany.mockResolvedValueOnce([{ code: "C-1003" }]).mockResolvedValueOnce([{ code: "C-1003" }, { code: "C-1004" }]);
    tx.customer.create.mockRejectedValueOnce(Object.assign(new Error("unique constraint failed"), { code: "P2002", meta: { target: ["Customer_code_key"] } }));
    const created = (await controller.create({ name: "مریم" } as never)) as { code: string };
    expect(created.code).toBe("C-1005");
    expect(tx.customer.findMany).toHaveBeenCalledTimes(2);
  });

  it("تصادم نوشتن (P2034) هم دوباره تلاش می‌شود", async () => {
    const { controller, tx, prisma } = setup();
    tx.customer.findMany.mockResolvedValue([{ code: "C-1002" }]);
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    let attempts = 0;
    prisma.$transaction.mockImplementation(async (work: (client: typeof tx) => unknown) => {
      attempts += 1;
      if (attempts === 1) throw conflict;
      return work(tx);
    });
    const created = (await controller.create({ name: "سمیع" } as never)) as { code: string };
    expect(created.code).toBe("C-1003");
    expect(attempts).toBe(2);
  });

  it("کد دستیِ تکراری → بدون تلاشِ دوباره، پیام دوستانه", async () => {
    const { controller, tx, prisma } = setup();
    const race = Object.assign(new Error("unique constraint failed"), { code: "P2002", meta: { target: ["Customer_code_key"] } });
    tx.customer.create.mockRejectedValueOnce(race);
    await expect(controller.create({ name: "زبیده", code: "C-1003" } as never)).rejects.toThrow("این کد برای مشتری دیگری ثبت شده است.");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.customer.findMany).not.toHaveBeenCalled();
  });

  it("ویرایش با کد تکراری → پیام دوستانه به‌جای خطای خام پرایسما", async () => {
    const { controller, prisma } = setup();
    prisma.customer.update.mockRejectedValueOnce(Object.assign(new Error("unique constraint failed"), { code: "P2002", meta: { target: ["Customer_code_key"] } }));
    await expect(controller.update("customer-1", { name: "احمد", code: "C-1003" } as never)).rejects.toThrow("این کد برای مشتری دیگری ثبت شده است.");
  });

  it("تأمین‌کننده ستون کد ندارد — فیلد code قبل از نوشتن کنار گذاشته می‌شود", async () => {
    const { controller } = supplierSetup();
    const prisma = (controller as unknown as { prisma: { supplier: { create: jest.Mock } } }).prisma;
    prisma.supplier.create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "s-new", ...data }));
    const created = (await controller.create({ name: "انبار مرکزی", code: "SHOULD-DROP" } as never)) as Record<string, unknown>;
    expect("code" in created).toBe(false);
    expect(prisma.supplier.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ code: expect.anything() }) }));
  });
});
