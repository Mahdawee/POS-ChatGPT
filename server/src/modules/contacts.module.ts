import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser, SessionUser } from "../auth";
import { ContactDto, CustomerPaymentDto } from "../dto";
import { PrismaService } from "../prisma.service";

@Controller("customers")
class CustomersController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.customer.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }); }
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
class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }); }
  @Post() create(@Body() dto: ContactDto) { return this.prisma.supplier.create({ data: { ...dto, name: dto.name.trim() } }); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: ContactDto) { return this.prisma.supplier.update({ where: { id }, data: { ...dto, name: dto.name.trim() } }); }
}

@Module({ controllers: [CustomersController, SuppliersController] })
export class ContactsModule {}
