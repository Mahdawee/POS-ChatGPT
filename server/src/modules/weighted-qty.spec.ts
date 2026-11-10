/**
 * رگرسیونِ خطای ممیز شناور در کالاهای وزنی (bug-hunt دور ۷۹).
 *
 * کالاهای وزنی تا سه رقم اعشار معتبرند، اما جمع ممیز شناور بدون گردکردن
 * منحرف می‌شود (۰٫۱ + ۰٫۲ = ۰٫۳۰۰۰…۴). پیش از فیکس، همین انحراف ساده سه
 * علامت واقعی داشت:
 *   ۱) دو خط ۰٫۱ و ۰٫۲ کیلو روی قفسهٔ ۰٫۳ → «موجودی کافی نیست» (غلط)؛
 *   ۲) موجودی ذخیره‌شده قدم‌به‌قدم آلوده می‌شد (۰٫۲ - ۰٫۱ = ۰٫۰۹۹…۹۸) و
 *      بعداً فروش ۰٫۲ را روی همان قفسه رد می‌کرد؛
 *   ۳) تقسیم موجودی اجزای بسته (۰٫۳ ÷ ۰٫۱ = ۲٫۹۹۹…) تعداد بسته‌های قابل‌ساخت
 *      را یکی کم نشان می‌داد (سمت کلاینت — اینجا سمت سرورِ آن یعنی «تقاضای
 *      مجموع» پوشش داده می‌شود).
 *
 * $executeRaw این تست همان معنای SQL واقعی را شبیه‌سازی می‌کند (نتیجه و گارد
 * هر دو ROUND(…,3)) تا رفتار SQLite همان‌طور که در checkout.ts نوشته شده
 * آزموده شود.
 */
import { ProductsController } from "./catalog.module";
import { CheckoutService } from "../services/checkout";

const admin = { id: "user-1", username: "admin", displayName: "Admin", role: "ADMIN" as const };
const rice = { id: "product-1", name: "برنج", sku: "R-1", stock: 0.3, price: 100, cost: 60, isActive: true, backstock: 0, reserved: 0, isBundle: false, isSerialized: false, isWeighted: true, unit: "کیلوگرم" };
const salt = { id: "product-2", name: "نمک", sku: "S-1", stock: 0.3, price: 20, cost: 10, isActive: true, backstock: 0, reserved: 0, isBundle: false, isSerialized: false, isWeighted: true, unit: "کیلوگرم" };
const kit = { id: "kit-1", name: "بستهٔ نمک", sku: "K-1", stock: 0, price: 50, cost: 30, isActive: true, backstock: 0, reserved: 0, isBundle: true, isSerialized: false };

const r3 = (value: number) => { const rounded = Math.round(value * 1000) / 1000; return rounded === 0 ? 0 : rounded; };

/** شبیه‌ساز قفسه با همان معنای SQL واقعی: گردکردن نتیجه و مقایسهٔ گردشده. */
function setup(products: Array<Record<string, unknown>>, stocks: Record<string, number>) {
  const shelf = new Map<string, number>(Object.entries(stocks));
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("ROUND(stock -")) {
        // UPDATE Product SET stock = ROUND(stock - ${q}, 3) WHERE id = .. AND ROUND(stock, 3) >= ${q}
        const [quantity, id] = values as [number, string];
        const base = shelf.get(id) ?? 0;
        if (r3(base) < quantity) return 0;
        shelf.set(id, r3(base - quantity));
        return 1;
      }
      if (sql.includes("SET stock = ROUND(stock, 3)")) {
        const [id] = values as [string];
        shelf.set(id, r3(shelf.get(id) ?? 0));
        return 1;
      }
      return 0;
    }),
    product: {
      findMany: jest.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
        products.filter((p) => !where?.id?.in || where.id.in.includes(p.id as string)).map((p) => ({ ...p, stock: stocks[p.id as string] ?? 0 }))),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, stock: shelf.get(where.id) ?? 0 })),
    },
    customer: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    sale: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditPart: null } }), create: jest.fn().mockResolvedValue({ id: "sale-1", receiptNo: "POS-1", items: [] }), findUnique: jest.fn().mockResolvedValue(null) },
    saleReturn: { aggregate: jest.fn().mockResolvedValue({ _sum: { creditRelief: null } }) },
    customerPayment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
    cashSession: { findFirst: jest.fn().mockResolvedValue({ id: "cash-1" }) },
    cashMovement: { create: jest.fn().mockResolvedValue({}) },
    setting: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    productBatch: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    bundleComponent: { findMany: jest.fn().mockResolvedValue([{ bundleId: "kit-1", component: { ...salt, stock: 0.3 }, quantity: 0.1 }]) },
    serialUnit: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    customerWalletTxn: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    sale: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  };
  return { service: new CheckoutService(prisma as never), tx, shelf };
}

const saleDto = (items: Array<{ productId: string; quantity: number }>) => ({ items, paymentMethod: "CASH" } as never);

describe("کالای وزنی — گردکردن مقادیر کمیت (رگرسیون ممیز شناور)", () => {
  it("دو خط ۰٫۱ و ۰٫۲ کیلو روی قفسهٔ ۰٫۳ فروخته می‌شود و موجودی دقیقاً صفر می‌ماند", async () => {
    const { service, shelf } = setup([rice], { "product-1": 0.3 });
    const sale = await service.checkout(saleDto([{ productId: "product-1", quantity: 0.1 }, { productId: "product-1", quantity: 0.2 }]), admin);
    expect(sale).toBeTruthy();
    expect(shelf.get("product-1")).toBe(0);
  });

  it("موجودیِ آلودهٔ تاریخی (۰٫۱۹۹…۹۸) فروشِ ۰٫۲ را رد نمی‌کند و همان‌جا التیام می‌یابد", async () => {
    const { service, shelf } = setup([rice], { "product-1": 0.19999999999999998 });
    await service.checkout(saleDto([{ productId: "product-1", quantity: 0.2 }]), admin);
    expect(shelf.get("product-1")).toBe(0);
  });

  it("فروشِ بیش از موجودی همچنان رد می‌شود (گارد اتمیک سالم است)", async () => {
    const { service, shelf } = setup([rice], { "product-1": 0.3 });
    await expect(service.checkout(saleDto([{ productId: "product-1", quantity: 0.1 }, { productId: "product-1", quantity: 0.25 }]), admin)).rejects.toThrow();
    expect(shelf.get("product-1")).toBe(0.3);
  });

  it("جزء وزنیِ ۰٫۱ کیلوییِ بسته: فروش ۳ بسته از موجودی ۰٫۳ دقیقاً قفسه را خالی می‌کند", async () => {
    const { service, shelf } = setup([kit, salt], { "kit-1": 0, "product-2": 0.3 });
    await service.checkout(saleDto([{ productId: "kit-1", quantity: 3 }]), admin);
    expect(shelf.get("product-2")).toBe(0);
  });

  it("قفسهٔ ۰٫۲ بعد از فروش ۰٫۱ دقیقاً ۰٫۱ می‌ماند (نه ۰٫۰۹۹…۹۸)", async () => {
    const { service, shelf } = setup([rice], { "product-1": 0.2 });
    await service.checkout(saleDto([{ productId: "product-1", quantity: 0.1 }]), admin);
    expect(shelf.get("product-1")).toBe(0.1);
  });
});

/** رگرسیون دور ۸۰: فرم کالای وزنی با موجودی اولیهٔ اعشاری (مثل ۰٫۳ کیلو)
 *  همیشه ۴۰۰ می‌خورد — DTO موجودی را @IsInt می‌گرفت در حالی که فرم (و CSV)
 *  برای کالای وزنی تا ۳ رقم اعشار می‌پذیرند. اعشار حالا آزاد و گارد
 *  «صحیح‌بودن» فقط برای کالای شمارشی در سرویس است. */
describe("کالای وزنی — موجودی اولیهٔ اعشاری در ثبت کالا", () => {
  const setupCatalog = () => {
    const tx = {
      product: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "new-1", ...data })),
        update: jest.fn().mockResolvedValue({}),
      },
      inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), auditLog: { create: jest.fn().mockResolvedValue({}) } };
    return { controller: new ProductsController(prisma as never), tx };
  };

  it("کالای وزنی با موجودی اولیهٔ ۰٫۳ ثبت می‌شود (قبلاً اعتبارسنجی ۴۰۰ می‌داد)", async () => {
    const { controller, tx } = setupCatalog();
    const product = await controller.create({ name: "پنیر", sku: "54321", price: 500, cost: 300, stock: 0.3, unit: "کیلوگرم", isWeighted: true });
    expect(product.stock).toBe(0.3);
    expect(tx.product.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stock: 0.3, isWeighted: true, minStock: 0 }) }));
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ quantity: 0.3, stockAfter: 0.3 }) }));
  });

  it("کالای شمارشی با موجودی اعشاری پیام روشن می‌گیرد و ذخیره نمی‌شود", async () => {
    const { controller, tx } = setupCatalog();
    await expect(controller.create({ name: "کتاب", sku: "B-1", price: 100, stock: 0.5, unit: "عدد" })).rejects.toThrow(/عدد صحیح/);
    expect(tx.product.create).not.toHaveBeenCalled();
  });
});
