import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { customerBalances, supplierBalances } from "../balances";
import { ContactDto, CustomerPaymentDto, SupplierPaymentDto } from "../dto";
import { PrismaService } from "../prisma.service";

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
  @Post() create(@Body() dto: ContactDto) { return this.prisma.customer.create({ data: { ...dto, name: dto.name.trim() } }); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: ContactDto) { return this.prisma.customer.update({ where: { id }, data: { ...dto, name: dto.name.trim() } }); }

  /** حساب نسیهٔ مشتری: مانده = فروش نسیه − برگشتی‌های نسیه − پرداخت‌ها */
  @Get(":id") async detail(@Param("id") id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("مشتری پیدا نشد.");
    const [creditSales, creditReturns, paymentsTotal, payments, recentSales] = await Promise.all([
      this.prisma.sale.aggregate({ _sum: { total: true }, where: { customerId: id, paymentMethod: "CREDIT" } }),
      this.prisma.saleReturn.aggregate({ _sum: { total: true }, where: { sale: { customerId: id, paymentMethod: "CREDIT" } } }),
      this.prisma.customerPayment.aggregate({ _sum: { amount: true }, where: { customerId: id } }),
      this.prisma.customerPayment.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 20, include: { user: { select: { displayName: true } } } }),
      this.prisma.sale.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 10, include: { items: true, user: { select: { displayName: true } } } }),
    ]);
    const creditTotal = creditSales._sum.total || 0;
    const returnsTotal = creditReturns._sum.total || 0;
    const paidTotal = paymentsTotal._sum.amount || 0;
    return { customer, creditSales: creditTotal, creditReturns: returnsTotal, paymentsTotal: paidTotal, balance: creditTotal - returnsTotal - paidTotal, payments, recentSales };
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
  @Post() create(@Body() dto: ContactDto) { return this.prisma.supplier.create({ data: { ...dto, name: dto.name.trim() } }); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: ContactDto) { return this.prisma.supplier.update({ where: { id }, data: { ...dto, name: dto.name.trim() } }); }

  /** حساب تأمین‌کننده: مانده = جمع خرید − پرداخت هنگام خرید − پرداخت‌های بعدی */
  @Get(":id") async detail(@Param("id") id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException("تأمین‌کننده پیدا نشد.");
    const [purchasesAgg, paymentsTotal, payments, recentPurchases] = await Promise.all([
      this.prisma.purchase.aggregate({ _sum: { total: true, paidAmount: true }, where: { supplierId: id } }),
      this.prisma.supplierPayment.aggregate({ _sum: { amount: true }, where: { supplierId: id } }),
      this.prisma.supplierPayment.findMany({ where: { supplierId: id }, orderBy: { createdAt: "desc" }, take: 20, include: { user: { select: { displayName: true } } } }),
      this.prisma.purchase.findMany({ where: { supplierId: id }, orderBy: { createdAt: "desc" }, take: 10, include: { items: true, user: { select: { displayName: true } } } }),
    ]);
    const purchasesTotal = purchasesAgg._sum.total || 0;
    const paidAtPurchase = purchasesAgg._sum.paidAmount || 0;
    const paidLater = paymentsTotal._sum.amount || 0;
    return { supplier, purchasesTotal, paidAtPurchase, paymentsTotal: paidLater, balance: purchasesTotal - paidAtPurchase - paidLater, payments, recentPurchases };
  }

  /** ثبت پرداخت به تأمین‌کننده — فقط ثبت حسابداری است؛ صندوق دست نمی‌خورد. */
  @Post(":id/payments")
  async pay(@Param("id") id: string, @Body() dto: SupplierPaymentDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id } });
      if (!supplier || !supplier.isActive) throw new BadRequestException("تأمین‌کننده پیدا نشد.");
      const payment = await tx.supplierPayment.create({ data: { supplierId: id, amount: dto.amount, note: dto.note?.trim(), userId: user.id }, include: { supplier: true } });
      await tx.auditLog.create({ data: { actor: user.username, action: "SUPPLIER_PAYMENT", entity: "Supplier", entityId: id, detail: String(dto.amount) } });
      return payment;
    });
  }
}

@Module({ controllers: [CustomersController, SuppliersController] })
export class ContactsModule {}
