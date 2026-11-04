import { BadRequestException, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { SessionUser } from "../auth";
import { PrismaService } from "../prisma.service";
import { CheckoutService } from "./checkout";
import { SalesController } from "../modules/sales.module";
import { PurchasesController, PurchaseReturnsController } from "../modules/purchases.module";
import { QuotesController } from "../modules/quotes.module";
import { OrdersController } from "../modules/orders.module";
import { InstallmentsController } from "../modules/installments.module";
import { ExpensesController } from "../modules/expenses.module";
import { CashController } from "../modules/cash.module";
import { SaleDto, PurchaseDto, QuoteDto, CreateOrderDto, DeliverOrderDto, CreateInstallmentPlanDto, ExpenseDto, CashMovementDto, OpenCashDto, SaleReturnDto, PurchaseReturnDto, PayInstallmentDto } from "../dto";

/**
 * بازنشانی کامل داده‌های فروشگاه + ساخت دیتای نمونهٔ همه‌جانبه.
 *
 * reset: همهٔ داده‌های تجاری (کالا، مشتری، فروش، خرید، سفارش، پیش‌فاکتور،
 * اقساط، هزینه، صندوق، اودیت) پاک می‌شود؛ کاربرها، تنظیمات و لایسنس
 * دست‌نخورده می‌مانند تا مدیر بلافاصله بتواند وارد شود و کار کند. خودِ
 * عملیات بازنشانی به‌عنوان یک رویداد اودیت ثبت می‌شود — سابقه هرگز
 * بی‌روایت پاک نمی‌شود.
 *
 * seed: یک «مغازهٔ زندهٔ نمونه» می‌سازد که هر قابلیت برنامه را پوشش
 * می‌دهد — کالای وزنی/سریال‌دار/بسته، قیمت عمده، انقضای نزدیک، کم‌موجود،
 * همهٔ روش‌های پرداخت (نقد/موبایل/نسیه/ترکیبی/کیف پول)، برگشت فروش و
 * خرید، ابطال، پیش‌فاکتور در هر سه وضعیت، سفارش رزروشده/تحویل‌شده/لغو،
 * اقساط با قسط سررسیدگذشته، هزینه و گردش صندوق — با تاریخ‌های پخش در
 * ۳۰ روز گذشته تا دفترها، نمودارها و گزارش‌ها هم داده داشته باشند.
 *
 * منطق هر سند از همان کنترلرهای واقعی عبور می‌کند (نه کپیِ دوباره)، پس
 * موجودی، صندوق، بالانس‌ها و اودیت همیشه سازگار می‌مانند.
 */
@Injectable()
export class SampleDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutService,
    private readonly sales: SalesController,
    private readonly purchases: PurchasesController,
    private readonly purchaseReturns: PurchaseReturnsController,
    private readonly quotes: QuotesController,
    private readonly orders: OrdersController,
    private readonly installments: InstallmentsController,
    private readonly expenses: ExpensesController,
    private readonly cash: CashController,
  ) {}

  /** تاریخ و ساعتِ «n روز پیش» — برای پخش‌کردن اسناد نمونه در طول زمان. */
  private daysAgo(days: number, hour = 10): Date {
    const date = new Date();
    date.setDate(date.getDate() - days);
    date.setHours(hour, (days * 13) % 60, 0, 0);
    return date;
  }
  private daysAhead(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  private isoOf(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  /** ── پاک‌سازی کامل ─────────────────────────────────────────────────── */
  async reset(user: SessionUser): Promise<Record<string, number>> {
    // Seed/sample روی دستگاه فروش واقعی هم می‌تواند اجرا شود؛ فقط مدیر
    // می‌تواند و خود عملیات لاگ می‌شود.
    if (user.role !== "ADMIN") throw new BadRequestException("فقط مدیر می‌تواند داده‌ها را بازنشانی کند.");
    const counts = {
      sales: await this.prisma.sale.count(),
      purchases: await this.prisma.purchase.count(),
      quotes: await this.prisma.quote.count(),
      orders: await this.prisma.customerOrder.count(),
      products: await this.prisma.product.count(),
      contacts: await this.prisma.customer.count() + await this.prisma.supplier.count(),
      expenses: await this.prisma.expense.count(),
      cashSessions: await this.prisma.cashSession.count(),
    };
    // ترتیب حذف: فرزندان قبل از والدین. کاربرها، تنظیمات و لایسنس حذف نمی‌شوند.
    await this.prisma.saleReturnItem.deleteMany();
    await this.prisma.saleReturn.deleteMany();
    await this.prisma.saleItem.deleteMany();
    await this.prisma.sale.deleteMany();
    await this.prisma.purchaseReturnItem.deleteMany();
    await this.prisma.purchaseReturn.deleteMany();
    await this.prisma.purchaseItem.deleteMany();
    await this.prisma.purchase.deleteMany();
    await this.prisma.quoteItem.deleteMany();
    await this.prisma.quote.deleteMany();
    await this.prisma.customerOrderLine.deleteMany();
    await this.prisma.customerOrder.deleteMany();
    await this.prisma.installment.deleteMany();
    await this.prisma.installmentPlan.deleteMany();
    await this.prisma.customerPayment.deleteMany();
    await this.prisma.supplierPayment.deleteMany();
    await this.prisma.customerWalletTxn.deleteMany();
    await this.prisma.expense.deleteMany();
    await this.prisma.cashMovement.deleteMany();
    await this.prisma.cashSession.deleteMany();
    await this.prisma.stocktakeLine.deleteMany();
    await this.prisma.stocktake.deleteMany();
    await this.prisma.inventoryMovement.deleteMany();
    await this.prisma.serialUnit.deleteMany();
    await this.prisma.bundleComponent.deleteMany();
    await this.prisma.productBatch.deleteMany();
    await this.prisma.product.deleteMany();
    await this.prisma.category.deleteMany();
    await this.prisma.customer.deleteMany();
    await this.prisma.supplier.deleteMany();
    await this.prisma.auditLog.deleteMany();
    // بعد از پاک‌سازی، حداقلِ لازم برای ادامهٔ کار: مشتری گذری و یک صندوق باز.
    await this.prisma.customer.create({ data: { id: "walk-in-customer", name: "مشتری گذری" } });
    const session = await this.prisma.cashSession.create({ data: { openingCash: 0, userId: user.id, note: "صندوق بعد از بازنشانی" } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "FACTORY_RESET", entity: "Database", entityId: session.id, detail: `sales=${counts.sales} purchases=${counts.purchases} quotes=${counts.quotes} orders=${counts.orders} products=${counts.products}` } });
    return counts;
  }

  /** ── ساخت دیتای نمونهٔ همه‌جانبه ───────────────────────────────────── */
  async seed(user: SessionUser): Promise<Record<string, unknown>> {
    if (user.role !== "ADMIN") throw new BadRequestException("فقط مدیر می‌تواند دیتای نمونه بسازد.");
    // Seed همیشه از صفر شروع می‌کند: هر دادهٔ مانده (از جمله کالاهای
    // bootstrap اولیه) اول پاک می‌شود — UI همین را در تأییدش می‌گوید.
    // seed خودِ reset دوباره صدا نمی‌زند که دوباره «صندوق بعد از بازنشانی»
    // ساخته شود؛ چون پایین‌تر صندوق نمونهٔ خودش را باز می‌کند.
    await this.reset(user);
    const admin = { id: user.id, username: user.username, displayName: user.displayName, role: "ADMIN" as const };

    // ── ۱) کاربر نمونهٔ صندوقدار (برای لاگ «صندوقدار» در اسناد) ─────────
    let cashier = await this.prisma.user.findUnique({ where: { username: "samim" } });
    if (!cashier) cashier = await this.prisma.user.create({ data: { username: "samim", displayName: "سمیع (صندوقدار نمونه)", passwordHash: await bcrypt.hash("12345678", 12), role: "CASHIER" } });
    const cashierUser: SessionUser = { id: cashier.id, username: cashier.username, displayName: cashier.displayName, role: "CASHIER" };

    // ── ۲) دسته‌ها و کالاها (موجودی از خرید می‌آید، نه ست مستقیم) ──────
    const cat = {
      grocery: await this.prisma.category.create({ data: { name: "خواربار", color: "#6f9f77" } }),
      drinks: await this.prisma.category.create({ data: { name: "نوشیدنی", color: "#729bc4" } }),
      home: await this.prisma.category.create({ data: { name: "لوازم خانه", color: "#c98c5b" } }),
      tech: await this.prisma.category.create({ data: { name: "دیجیتال", color: "#8b7ec8" } }),
    };
    const product = async (data: Parameters<typeof this.prisma.product.create>[0]["data"]) => this.prisma.product.create({ data });
    const rice = await product({ sku: "G-1001", barcode: "1001000001", name: "برنج باسمتی (۱ کیلو)", unit: "بسته", price: 145, cost: 112, stock: 0, minStock: 5, categoryId: cat.grocery.id });
    const oil = await product({ sku: "G-1002", barcode: "1001000002", name: "روغن آفتابگردان (۱ لیتر)", unit: "بوتل", price: 98, cost: 76, stock: 0, minStock: 5, categoryId: cat.grocery.id });
    const tea = await product({ sku: "G-1003", barcode: "1001000003", name: "چای سبز (۲۵ پاکت)", unit: "بسته", price: 120, cost: 90, stock: 0, minStock: 4, categoryId: cat.grocery.id });
    const apple = await product({ sku: "G-1004", barcode: "1004000004", name: "سیب قرمز", unit: "کیلو", isWeighted: true, price: 65, cost: 48, stock: 0, minStock: 5, categoryId: cat.grocery.id });
    const meat = await product({ sku: "G-1005", barcode: "1005000005", name: "گوشت چرخ‌کرده", unit: "کیلو", isWeighted: true, price: 320, cost: 260, stock: 0, minStock: 3, categoryId: cat.grocery.id });
    const water = await product({ sku: "D-2001", barcode: "2001000001", name: "آب معدنی (۱.۵ لیتر)", unit: "بوتل", price: 25, cost: 14, stock: 0, minStock: 8, categoryId: cat.drinks.id });
    const soda = await product({ sku: "D-2002", barcode: "2001000002", name: "نوشابه قوطی", unit: "عدد", price: 35, cost: 24, stock: 0, minStock: 8, categoryId: cat.drinks.id });
    const milk = await product({ sku: "D-2003", barcode: "2003000003", name: "شیر تازه (۱ لیتر)", unit: "بسته", price: 60, cost: 45, stock: 0, minStock: 6, categoryId: cat.drinks.id });
    const soap = await product({ sku: "H-3001", barcode: "3001000001", name: "صابون دست‌شویی", unit: "عدد", price: 32, cost: 21, stock: 0, minStock: 10, categoryId: cat.home.id });
    const shampoo = await product({ sku: "H-3002", barcode: "3002000002", name: "شامپو خانواده", unit: "عدد", price: 145, cost: 105, wholesalePrice: 120, wholesaleMinQty: 6, stock: 0, minStock: 6, categoryId: cat.home.id });
    const laptop = await product({ sku: "T-4001", barcode: "4001000001", name: "لپ‌تپ لنوو IdeaPad", unit: "عدد", isSerialized: true, price: 45000, cost: 38000, stock: 0, minStock: 1, categoryId: cat.tech.id });
    const phone = await product({ sku: "T-4002", barcode: "4002000002", name: "گوشی سامسونگ A15", unit: "عدد", isSerialized: true, price: 18500, cost: 15500, stock: 0, minStock: 1, categoryId: cat.tech.id });
    const flash = await product({ sku: "T-4003", barcode: "4003000003", name: "فلش مموری ۳۲GB", unit: "عدد", price: 350, cost: 240, stock: 0, minStock: 5, categoryId: cat.tech.id });
    // بسته (کیت): اجزایش هنگام فروش از انبار کم می‌شوند.
    const hygieneKit = await product({ sku: "K-5001", name: "بستهٔ بهداشتی خانه (صابون ۲ + شامپو ۱)", unit: "بسته", isBundle: true, price: 195, cost: 0, stock: 0, categoryId: cat.home.id });
    await this.prisma.bundleComponent.createMany({ data: [
      { bundleId: hygieneKit.id, componentId: soap.id, quantity: 2 },
      { bundleId: hygieneKit.id, componentId: shampoo.id, quantity: 1 },
    ] });

    // ── ۳) مشتری‌ها و تأمین‌کنندگان ────────────────────────────────────
    // «مشتری گذری» را reset از قبل ساخته است؛ دوباره ساخته نمی‌شود.
    const ahmad = await this.prisma.customer.create({ data: { name: "احمد ولی‌زاده", phone: "0700111222", address: "کابل، چهارراهی انصاری", creditLimit: 5000, tier: "RETAIL", note: "مشتری ثابت؛ خرید نسیه دارد." } });
    const nabih = await this.prisma.customer.create({ data: { name: "تعاونی تجاری نبیگل", phone: "0744556677", tier: "WHOLESALE", note: "خرید عمده — قیمت عمده اعمال می‌شود." } });
    const maryam = await this.prisma.customer.create({ data: { name: "مریم کریمی", phone: "0788990011", tier: "RETAIL", note: "کیف پول شارژ دارد." } });
    const hussein = await this.prisma.customer.create({ data: { name: "حسین اکبری", phone: "0799223344", creditLimit: 25000, tier: "RETAIL" } });
    const trading = await this.prisma.supplier.create({ data: { name: "شرکت بازرگانی کابل", phone: "0201234567", address: "شهر نو، بازار سرای‌شاهزاده" } });
    const fruitWhole = await this.prisma.supplier.create({ data: { name: "عمده‌فروشی میوه شهدا", phone: "0700554433" } });

    // شارژ کیف پول مریم (واریز نقدی به صندوق همراه ندارد — شارژ مستقیم)
    await this.prisma.customer.update({ where: { id: maryam.id }, data: { walletBalance: 2000 } });
    await this.prisma.customerWalletTxn.create({ data: { customerId: maryam.id, type: "CHARGE", amount: 2000, note: "شارژ اولیهٔ کیف پول (دیتای نمونه)", userId: user.id } });

    // ── ۴) صندوق: نوبت کاری باز با پول آغازین (reset یکی با صفر ساخته) ─
    await this.prisma.cashSession.updateMany({ where: { status: "OPEN" }, data: { openingCash: 5000, note: "شروع نوبت (دیتای نمونه)" } });

    // ── ۵) خریدها — موجودی، هزینه و سریال‌ها از همین‌جا می‌آیند ─────────
    const purchase1 = await this.purchases.create(await purchaseDto({ supplierId: trading.id, invoiceNo: "INV-KBL-001", note: "رسید اصلی الکترونیک و بهداشتی", items: [
      { productId: laptop.id, quantity: 3, unitCost: 38000, serials: ["LT-26001", "LT-26002", "LT-26003"] },
      { productId: phone.id, quantity: 4, unitCost: 15500, serials: ["SM-A15-001", "SM-A15-002", "SM-A15-003", "SM-A15-004"] },
      { productId: flash.id, quantity: 20, unitCost: 240 },
      { productId: shampoo.id, quantity: 30, unitCost: 105 },
      { productId: soap.id, quantity: 60, unitCost: 21 },
    ] }), admin);
    await this.prisma.purchase.update({ where: { id: purchase1.id }, data: { createdAt: this.daysAgo(26) } });

    const purchase2 = await this.purchases.create(await purchaseDto({ supplierId: fruitWhole.id, invoiceNo: "FRUIT-014", note: "میوه و گوشت — بخشی نقد، بقیه نسیه", paidAmount: 3000, items: [
      { productId: apple.id, quantity: 60, unitCost: 48 },
      { productId: meat.id, quantity: 25, unitCost: 260 },
    ] }), admin);
    await this.prisma.purchase.update({ where: { id: purchase2.id }, data: { createdAt: this.daysAgo(24) } });

    const purchase3 = await this.purchases.create(await purchaseDto({ supplierId: trading.id, invoiceNo: "INV-KBL-002", note: "خواربار و نوشیدنی — شیر و روغن با انقضای نزدیک", items: [
      { productId: rice.id, quantity: 40, unitCost: 112 },
      { productId: oil.id, quantity: 30, unitCost: 76, expiryDate: this.isoOf(this.daysAhead(15)) },
      { productId: tea.id, quantity: 15, unitCost: 90 },
      { productId: milk.id, quantity: 20, unitCost: 45, expiryDate: this.isoOf(this.daysAhead(7)) },
      { productId: water.id, quantity: 12, unitCost: 14 },
      { productId: soda.id, quantity: 40, unitCost: 24 },
    ] }), admin);
    await this.prisma.purchase.update({ where: { id: purchase3.id }, data: { createdAt: this.daysAgo(23) } });

    // برگشت خرید: دو فلش معیوب به تأمین‌کننده برگشت.
    const purchaseReturnDto = new PurchaseReturnDto();
    purchaseReturnDto.purchaseId = purchase1.id;
    purchaseReturnDto.note = "دو فلش معیوب برگشت (دیتای نمونه)";
    purchaseReturnDto.items = [{ productId: flash.id, quantity: 2 }];
    await this.purchaseReturns.createReturn(purchaseReturnDto, admin);

    // ── ۶) فروش‌ها — هر سناریویی که دفتر و گزارش باید نشان دهد ──────────
    const sale = async (dto: Partial<SaleDto>, by: SessionUser, daysBack: number) => {
      const full = Object.assign(new SaleDto(), dto);
      const created = await this.checkout.checkout(full, by, `sample-${Math.random().toString(36).slice(2, 10)}`) as { id: string };
      await this.prisma.sale.update({ where: { id: created.id }, data: { createdAt: this.daysAgo(daysBack) } });
      return created;
    };
    // نقدی ساده (صندوقدار)
    await sale({ items: [{ productId: rice.id, quantity: 2 }, { productId: tea.id, quantity: 1 }], paymentMethod: "CASH" }, cashierUser, 22);
    // نقدی با اضافه‌پرداخت (باقی‌پول)
    await sale({ items: [{ productId: soda.id, quantity: 3 }], paymentMethod: "CASH", amountPaid: 200 }, cashierUser, 20);
    // پرداخت موبایلی
    await sale({ items: [{ productId: shampoo.id, quantity: 2 }], paymentMethod: "MOBILE" }, admin, 18);
    // نسیه برای احمد (بدهکار می‌شود)
    await sale({ customerId: ahmad.id, items: [{ productId: oil.id, quantity: 4 }, { productId: milk.id, quantity: 2 }], paymentMethod: "CREDIT", amountPaid: 0 }, cashierUser, 16);
    // کالای وزنی
    await sale({ items: [{ productId: apple.id, quantity: 1.5 }, { productId: meat.id, quantity: 0.75 }], paymentMethod: "CASH" }, cashierUser, 14);
    // خرید عمده — قیمت عمده خودکار اعمال می‌شود
    await sale({ customerId: nabih.id, items: [{ productId: shampoo.id, quantity: 12 }, { productId: soap.id, quantity: 24 }], paymentMethod: "CASH" }, admin, 12);
    // پرداخت ترکیبی: بخش نقد + موبایل + باقیمانده نسیه
    await sale({ customerId: ahmad.id, items: [{ productId: rice.id, quantity: 3 }], paymentMethod: "CREDIT", splitCash: 200, splitMobile: 150 }, cashierUser, 10);
    // کالای سریال‌دار (IMEI)
    await sale({ items: [{ productId: laptop.id, quantity: 1, serials: ["LT-26001"] }], paymentMethod: "CASH" }, admin, 8);
    // بسته (کیت)
    await sale({ items: [{ productId: hygieneKit.id, quantity: 2 }], paymentMethod: "CASH" }, cashierUser, 6);
    // کیف پول
    await sale({ customerId: maryam.id, items: [{ productId: milk.id, quantity: 3 }, { productId: water.id, quantity: 6 }], paymentMethod: "WALLET" }, cashierUser, 4);
    // تخفیف‌ها: نقدی، درصدی و قلمی
    await sale({ items: [{ productId: tea.id, quantity: 2 }], paymentMethod: "CASH", discount: 50 }, admin, 3);
    await sale({ items: [{ productId: oil.id, quantity: 2 }], paymentMethod: "MOBILE", discountPercent: 10 }, admin, 3);
    await sale({ items: [{ productId: rice.id, quantity: 1, discount: 20 }], paymentMethod: "CASH" }, cashierUser, 2);
    // فاکتوری که برگشت جزئی می‌شود (نوشابه) و فاکتور اقساطی (گوشی برای حسین)
    const returnedSale = await sale({ items: [{ productId: soda.id, quantity: 5 }, { productId: soap.id, quantity: 3 }], paymentMethod: "CASH" }, cashierUser, 2);
    const installmentSale = await sale({ customerId: hussein.id, items: [{ productId: phone.id, quantity: 1, serials: ["SM-A15-002"] }], paymentMethod: "CREDIT", amountPaid: 0 }, admin, 1);
    // فاکتوری که ابطال می‌شود (ثبت اشتباه)
    const voidedSale = await sale({ items: [{ productId: tea.id, quantity: 3 }], paymentMethod: "CASH" }, cashierUser, 1);
    await this.prisma.sale.update({ where: { id: voidedSale.id }, data: { voidedAt: this.daysAgo(1, 12), voidReason: "ثبت اشتباه شمارهٔ کالا — بازخواست مشتری", voidedBy: user.id } });
    // برگشت جزئی: ۲ قوطی نوشابه از فاکتور برگشتی (موجودی برمی‌گردد، صندوق تنظیم می‌شود)
    const saleReturnDto = new SaleReturnDto();
    saleReturnDto.items = [{ productId: soda.id, quantity: 2 }];
    saleReturnDto.note = "نوشابه‌ها معیوب بود — برگشت جزئی (دیتای نمونه)";
    await this.sales.returnSale(returnedSale.id, saleReturnDto, admin);

    // ── ۷) پیش‌فاکتورها: باز، تبدیل‌شده، ابطال‌شده ──────────────────────
    const openQuote = await this.quotes.create(await quoteDto({ customerId: nabih.id, note: "پیش‌فاکتور باز — هنوز تبدیل نشده", items: [{ productId: phone.id, quantity: 1 }, { productId: flash.id, quantity: 2 }] }), admin);
    void openQuote;
    const convertible = await this.quotes.create(await quoteDto({ customerId: ahmad.id, note: "پیش‌فاکتور تبدیل‌شده به فروش", items: [{ productId: tea.id, quantity: 3 }] }), admin);
    const convertedSale = await this.quotes.convert(convertible.id, { items: [] }, admin) as { id: string };
    void convertedSale;
    const voidedQuote = await this.quotes.create(await quoteDto({ customerId: maryam.id, note: "پیش‌فاکتور قدیمی — مشتری انصراف داد", items: [{ productId: milk.id, quantity: 2 }] }), admin);
    await this.quotes.void(voidedQuote.id, admin);

    // ── ۸) سفارش‌های مشتری (رزرو موجودی) ────────────────────────────────
    const openOrder = await this.orders.create(await orderDto({ customerId: ahmad.id, note: "سفارش باز — موجودی رزرو شده", items: [{ productId: flash.id, quantity: 5 }] }), admin);
    void openOrder;
    const deliverable = await this.orders.create(await orderDto({ customerId: maryam.id, note: "سفارش تحویل‌شده", items: [{ productId: phone.id, quantity: 1 }] }), admin);
    const deliverLine = (await this.prisma.customerOrderLine.findFirst({ where: { orderId: deliverable.id } }))!;
    const deliverDto = new DeliverOrderDto();
    deliverDto.deliveries = [{ lineId: deliverLine.id, quantity: 1, serials: ["SM-A15-003"] }];
    deliverDto.paymentMethod = "CASH";
    await this.orders.deliver(deliverable.id, deliverDto, admin);
    const cancelled = await this.orders.create(await orderDto({ customerId: nabih.id, note: "سفارش لغو‌شده", items: [{ productId: apple.id, quantity: 10 }] }), admin);
    await this.orders.cancel(cancelled.id, admin);

    // ── ۹) اقساط: یک قسط سررسیدگذشته + یک پلن تازه ────────────────────
    const planDto = new CreateInstallmentPlanDto();
    planDto.customerId = hussein.id;
    planDto.total = 18500;
    planDto.installmentCount = 4;
    planDto.intervalDays = 30;
    planDto.startDate = this.isoOf(this.daysAgo(40));
    planDto.note = "پلن خرید گوشی (دیتای نمونه)";
    planDto.saleId = installmentSale.id;
    const plan = await this.installments.create(planDto, admin) as { id: string; installments: Array<{ id: string; seq: number }> };
    // قسط ۱ پرداخت می‌شود؛ قسط ۲ سررسیدش گذشته و پرداخت‌نشده می‌ماند (overdue).
    const firstInstallment = plan.installments.find((item) => item.seq === 1)!;
    const payDto = new PayInstallmentDto();
    payDto.amount = 4625;
    payDto.fromCash = true;
    await this.installments.pay(firstInstallment.id, payDto, admin);
    const plan2 = new CreateInstallmentPlanDto();
    plan2.customerId = ahmad.id;
    plan2.total = 600;
    plan2.installmentCount = 3;
    plan2.intervalDays = 30;
    plan2.startDate = this.isoOf(this.daysAhead(5));
    plan2.note = "تقسیط بدهی کوچک (دیتای نمونه)";
    await this.installments.create(plan2, admin);

    // ── ۱۰) هزینه‌ها و گردش صندوق ──────────────────────────────────────
    const expense = async (title: string, amount: number, category: string, daysBack: number, fromCash = true) => {
      const dto = new ExpenseDto();
      dto.title = title; dto.amount = amount; dto.category = category; dto.fromCash = fromCash;
      const created = await this.expenses.create(dto, admin) as { id: string };
      await this.prisma.expense.update({ where: { id: created.id }, data: { createdAt: this.daysAgo(daysBack) } });
    };
    await expense("کرایه حمل کالا", 300, "حمل‌ونقل", 19);
    await expense("قبض برق", 450, "خدمات", 9);
    await expense("مواد بسته‌بندی", 120, "مصرف", 4);
    await expense("اینترنت ماهانه", 600, "خدمات", 1, false);
    const movementDto = new CashMovementDto();
    movementDto.type = "IN"; movementDto.amount = 2000; movementDto.description = "واریز پول گردش (دیتای نمونه)";
    await this.cash.movement(movementDto, admin);
    const outDto = new CashMovementDto();
    outDto.type = "OUT"; outDto.amount = 500; outDto.description = "برداشت برای خرید ملزومات (دیتای نمونه)";
    await this.cash.movement(outDto, admin);

    await this.prisma.auditLog.create({ data: { actor: user.username, action: "SEED_SAMPLE_DATA", entity: "Database", detail: "sample dataset created" } });

    // خروجی: شمارش نهایی برای پیام تأیید UI
    const [productCount, saleCount, purchaseCount, quoteCount, orderCount, customerCount, supplierCount, expenseCount, installmentCount, serialCount] = await Promise.all([
      this.prisma.product.count(), this.prisma.sale.count(), this.prisma.purchase.count(), this.prisma.quote.count(),
      this.prisma.customerOrder.count(), this.prisma.customer.count(), this.prisma.supplier.count(), this.prisma.expense.count(),
      this.prisma.installmentPlan.count(), this.prisma.serialUnit.count(),
    ]);
    return { products: productCount, sales: saleCount, purchases: purchaseCount, quotes: quoteCount, orders: orderCount, customers: customerCount, suppliers: supplierCount, expenses: expenseCount, installmentPlans: installmentCount, serialUnits: serialCount };
  }
}

/** سازندهٔ DTO خرید بدون اعتبارسنجی HTTP (مقادیر seed همیشه معتبرند). */
async function purchaseDto(input: { supplierId?: string; invoiceNo?: string; note?: string; paidAmount?: number; items: Array<{ productId: string; quantity: number; unitCost?: number; expiryDate?: string; serials?: string[] }> }): Promise<PurchaseDto> {
  const dto = new PurchaseDto();
  dto.supplierId = input.supplierId;
  dto.invoiceNo = input.invoiceNo;
  dto.note = input.note;
  dto.paidAmount = input.paidAmount;
  dto.items = input.items.map((line) => ({ productId: line.productId, quantity: line.quantity, unitCost: line.unitCost, expiryDate: line.expiryDate, serials: line.serials }));
  return dto;
}
async function quoteDto(input: { customerId?: string; note?: string; items: Array<{ productId: string; quantity: number }> }): Promise<QuoteDto> {
  const dto = new QuoteDto();
  dto.customerId = input.customerId;
  dto.note = input.note;
  dto.items = input.items.map((line) => ({ productId: line.productId, quantity: line.quantity }));
  return dto;
}
async function orderDto(input: { customerId?: string; note?: string; items: Array<{ productId: string; quantity: number }> }): Promise<CreateOrderDto> {
  const dto = new CreateOrderDto();
  dto.customerId = input.customerId;
  dto.note = input.note;
  dto.items = input.items.map((line) => ({ productId: line.productId, quantity: line.quantity }));
  return dto;
}
