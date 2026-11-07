import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { AUTO_CODE_ATTEMPTS, autoCodeRetryDelay, isAutoCodeRace, serialized } from "../auto-code";
import { customerBalances, supplierBalances } from "../balances";
import { ContactDto, CustomerPaymentDto, SupplierPaymentDto, WalletChargeDto } from "../dto";
import { PrismaService } from "../prisma.service";

/** تراکنشی که فقط جدول مشتری را می‌خواند — همان TransactionClient پرایسما. */
type CustomerTx = { customer: { findMany(args: unknown): Promise<Array<{ code: string | null }>> } };

/** کد مشتری خودکار — کوتاه و خوانا: C-1001، C-1002 … همیشه «بزرگ‌ترین
 *  شمارهٔ موجود + ۱» تا با کدهای دستی کاربر تصادم نکند. داخل تراکنشِ
 *  ثبت خوانده می‌شود تا دو ثبتِ همزمان هر دو همان شماره را نگیرند. */
async function nextCustomerCode(tx: CustomerTx): Promise<string> {
  const rows = await tx.customer.findMany({ where: { code: { startsWith: "C-" } }, select: { code: true } });
  const max = rows.reduce((acc, row) => {
    const match = /^C-(\d+)$/.exec(row.code || "");
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 1000);
  return `C-${max + 1}`;
}

/** قید یکتای کد (schema.sql) برای کد دستیِ تکراری با پیام روشن برمی‌گردد،
 *  نه با خطای خام پرایسما. */
function mapCustomerConflict(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002") {
    return new BadRequestException("این کد برای مشتری دیگری ثبت شده است.");
  }
  return error;
}

@Controller("customers")
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}
  /** Active customers with their outstanding credit balance attached. */
  @Get() async list() {
    const [customers, balance] = await Promise.all([
      this.prisma.customer.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
      customerBalances(this.prisma),
    ]);
    return customers.map((customer) => ({ ...customer, balance: balance.get(customer.id) || 0 }));
  }
  @Post() async create(@Body() dto: ContactDto) {
    // کد خالی → کد خودکارِ پیوسته؛ ثبت مشتری بدون تایپِ کد ممکن است.
    // خواندنِ شمارهٔ بعدی و نوشتن در «یک» تراکنش انجام می‌شود و اگر دو
    // ثبتِ همزمان هر دو همان کد را ساختند، قید یکتا بازنده را با
    // P2002/P2034 برمی‌گرداند — تلاشِ تازه شمارهٔ درست را می‌گیرد.
    const { code: _code, ...rest } = dto;
    const autoCode = !dto.code?.trim();
    for (let attempt = 1; ; attempt++) {
      try {
        return await serialized(() => this.prisma.$transaction(async (tx) => {
          const code = dto.code?.trim() || await nextCustomerCode(tx as unknown as CustomerTx);
          return tx.customer.create({ data: { ...rest, code, name: dto.name.trim() } });
        }));
      } catch (error) {
        if (autoCode && attempt < AUTO_CODE_ATTEMPTS && isAutoCodeRace(error)) { await autoCodeRetryDelay(attempt); continue; }
        throw mapCustomerConflict(error);
      }
    }
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: ContactDto) {
    const { code, ...rest } = dto;
    try {
      return await this.prisma.customer.update({ where: { id }, data: { ...rest, code: code?.trim() || undefined, name: dto.name.trim() } });
    } catch (error) {
      throw mapCustomerConflict(error);
    }
  }

  /** حساب نسیهٔ مشتری: مانده = فروش نسیه − برگشتی‌های نسیه − پرداخت‌ها */
  @Get(":id") async detail(@Param("id") id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("مشتری پیدا نشد.");
    const [creditSales, creditReturns, paymentsTotal, payments, recentSales, walletTxns] = await Promise.all([
      this.prisma.sale.aggregate({ _sum: { creditPart: true }, where: { customerId: id, creditPart: { gt: 0 }, voidedAt: null } }),
      this.prisma.saleReturn.aggregate({ _sum: { creditRelief: true }, where: { sale: { customerId: id, creditPart: { gt: 0 } } } }),
      this.prisma.customerPayment.aggregate({ _sum: { amount: true }, where: { customerId: id } }),
      this.prisma.customerPayment.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 20, include: { user: { select: { displayName: true } } } }),
      this.prisma.sale.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 10, include: { items: true, user: { select: { displayName: true } } } }),
      this.prisma.customerWalletTxn.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
    ]);
    const creditTotal = creditSales._sum.creditPart || 0;
    const returnsTotal = creditReturns._sum.creditRelief || 0;
    const paidTotal = paymentsTotal._sum.amount || 0;
    return { customer, creditSales: creditTotal, creditReturns: returnsTotal, paymentsTotal: paidTotal, balance: creditTotal - returnsTotal - paidTotal, payments, recentSales, walletTxns, walletBalance: customer.walletBalance };
  }

  /** شارژ کیف پول مشتری: موجودی بالا می‌رود و در دفتر کیف پول ثبت می‌شود. */
  @Post(":id/wallet/charge")
  async chargeWallet(@Param("id") id: string, @Body() dto: WalletChargeDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id } });
      if (!customer || !customer.isActive) throw new BadRequestException("مشتری پیدا نشد.");
      let cashSessionId: string | undefined;
      if (dto.fromCash) {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
        if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
        cashSessionId = session.id;
        // The customer hands cash OVER and receives wallet credit: money
        // enters the drawer (IN), exactly like an installment collection.
        // Booking it as OUT used to shrink the expected cash and surface a
        // false surplus on every Z-report.
        await tx.cashMovement.create({ data: { type: "IN", amount: dto.amount, description: `شارژ کیف پول ${customer.name}`, cashSessionId: session.id } });
      }
      const updated = await tx.customer.update({ where: { id }, data: { walletBalance: { increment: dto.amount } } });
      const txn = await tx.customerWalletTxn.create({ data: { customerId: id, type: "CHARGE", amount: dto.amount, note: dto.note?.trim(), cashSessionId, userId: user.id } });
      await tx.auditLog.create({ data: { actor: user.username, action: "WALLET_CHARGE", entity: "Customer", entityId: id, detail: `${dto.amount}${dto.fromCash ? " / از صندوق" : ""}` } });
      return { walletBalance: updated.walletBalance, txn };
    });
  }

  @Post(":id/payments")
  async pay(@Param("id") id: string, @Body() dto: CustomerPaymentDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id } });
      if (!customer || !customer.isActive) throw new BadRequestException("مشتری پیدا نشد.");
      let cashSessionId: string | undefined;
      const session = await tx.cashSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
      if (session) {
        cashSessionId = session.id;
        await tx.cashMovement.create({ data: { type: "IN", amount: dto.amount, description: `وصول نسیه ${customer.name}`, cashSessionId: session.id } });
      }
      const payment = await tx.customerPayment.create({ data: { customerId: id, amount: dto.amount, note: dto.note?.trim(), cashSessionId, userId: user.id }, include: { customer: true } });
      await tx.auditLog.create({ data: { actor: user.username, action: "CUSTOMER_PAYMENT", entity: "Customer", entityId: id, detail: String(dto.amount) } });
      return payment;
    });
  }
}

@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}
  /** Active suppliers with their outstanding balance (purchases − paid at purchase − later payments). */
  @Get() async list() {
    const [suppliers, balance] = await Promise.all([
      this.prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
      supplierBalances(this.prisma),
    ]);
    return suppliers.map((supplier) => ({ ...supplier, balance: balance.get(supplier.id) || 0 }));
  }
  // DTO با مشتری مشترک است؛ تأمین‌کننده ستون‌های code/creditLimit/tier ندارد →
  // فقط فیلدهای معتبرش را می‌نویسیم تا نسخه‌های قدیمی کلاینت (که این فیلدها
  // را می‌فرستادند) هرگز به خطای پرایسما نخورند.
  @Post() create(@Body() dto: ContactDto) {
    return this.prisma.supplier.create({ data: { name: dto.name.trim(), phone: dto.phone, address: dto.address, note: dto.note } });
  }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: ContactDto) {
    return this.prisma.supplier.update({ where: { id }, data: { name: dto.name.trim(), phone: dto.phone, address: dto.address, note: dto.note } });
  }

  /** حساب تأمین‌کننده: مانده = جمع خرید − پرداخت هنگام خرید − پرداخت‌های بعدی */
  @Get(":id") async detail(@Param("id") id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException("تأمین‌کننده پیدا نشد.");
    const [purchasesAgg, paymentsTotal, payments, recentPurchases] = await Promise.all([
      this.prisma.purchase.aggregate({ _sum: { total: true, paidAmount: true }, where: { supplierId: id, voidedAt: null } }),
      this.prisma.supplierPayment.aggregate({ _sum: { amount: true }, where: { supplierId: id } }),
      this.prisma.supplierPayment.findMany({ where: { supplierId: id }, orderBy: { createdAt: "desc" }, take: 20, include: { user: { select: { displayName: true } } } }),
      this.prisma.purchase.findMany({ where: { supplierId: id }, orderBy: { createdAt: "desc" }, take: 10, include: { items: true, user: { select: { displayName: true } } } }),
    ]);
    const purchasesTotal = purchasesAgg._sum.total || 0;
    const paidAtPurchase = purchasesAgg._sum.paidAmount || 0;
    const paidLater = paymentsTotal._sum.amount || 0;
    return { supplier, purchasesTotal, paidAtPurchase, paymentsTotal: paidLater, balance: purchasesTotal - paidAtPurchase - paidLater, payments, recentPurchases };
  }

  /** ثبت پرداخت به تأمین‌کننده؛ با fromCash مبلغ از صندوق باز خارج می‌شود. */
  @Post(":id/payments")
  async pay(@Param("id") id: string, @Body() dto: SupplierPaymentDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id } });
      if (!supplier || !supplier.isActive) throw new BadRequestException("تأمین‌کننده پیدا نشد.");
      // Money leaves the drawer only when the caller explicitly asks for it
      // and a register is open; otherwise it is bookkeeping only.
      if (dto.fromCash) {
        const session = await tx.cashSession.findFirst({ where: { status: "OPEN" } });
        if (!session) throw new BadRequestException("صندوق باز وجود ندارد.");
        await tx.cashMovement.create({ data: { type: "OUT", amount: dto.amount, description: `پرداخت به تأمین‌کننده ${supplier.name}`, cashSessionId: session.id } });
      }
      const payment = await tx.supplierPayment.create({ data: { supplierId: id, amount: dto.amount, note: dto.note?.trim(), userId: user.id }, include: { supplier: true } });
      await tx.auditLog.create({ data: { actor: user.username, action: "SUPPLIER_PAYMENT", entity: "Supplier", entityId: id, detail: `${dto.amount}${dto.fromCash ? " / از صندوق" : ""}` } });
      return payment;
    });
  }
}

@Module({ controllers: [CustomersController, SuppliersController] })
export class ContactsModule {}
