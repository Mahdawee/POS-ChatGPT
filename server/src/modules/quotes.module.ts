import { BadRequestException, Body, Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CurrentUser, SessionUser } from "../auth";
import { QuoteDto , ConvertQuoteDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { roundQty } from "../quantities";
import { CheckoutService } from "../services/checkout";

/**
 * Quotes (پیش‌فاکتور): a saved basket the customer can approve later.
 * Converting a quote runs the normal checkout and keeps the link, so the
 * quote stays as a paper trail of what was offered.
 */
@Controller("quotes")
export class QuotesController {
  constructor(private readonly prisma: PrismaService, private readonly checkoutService: CheckoutService) {}

  @Get()
  list(@Query("skip") skip?: string, @Query("take") take?: string) {
    // Windowed like sales/purchases, so quotes beyond the first page stay
    // reachable through "load more" instead of disappearing.
    const limit = Math.min(300, Math.max(1, Number(take) || 100));
    const offset = Math.max(0, Number(skip) || 0);
    return this.prisma.quote.findMany({
      skip: offset,
      take: limit,
      include: { customer: { select: { id: true, name: true } }, _count: { select: { items: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const quote = await this.prisma.quote.findUnique({ where: { id }, include: { customer: true, items: true } });
    if (!quote) throw new BadRequestException("پیش‌فاکتور پیدا نشد.");
    return quote;
  }

  @Post()
  async create(@Body() dto: QuoteDto, @CurrentUser() user: SessionUser) {
    const quantities = new Map<string, number>();
    for (const line of dto.items) quantities.set(line.productId, roundQty((quantities.get(line.productId) || 0) + line.quantity));
    const lines = [...quantities.entries()];
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map(([id]) => id) }, isActive: true } });
      if (products.length !== lines.length) throw new BadRequestException("یکی از کالاها غیرفعال است یا پیدا نشد.");
      const productMap = new Map(products.map((product) => [product.id, product]));
      // Countable goods are quoted in whole units (round-30 stepper repair);
      // fractional counts would demand a fractional serial count at conversion.
      for (const [productId, quantity] of quantities) {
        const product = productMap.get(productId)!;
        if (product.isWeighted) continue;
        const rounded = Math.round(quantity);
        if (rounded < 1) throw new BadRequestException(`تعداد «${product.name}» باید عدد صحیح و حداقل ۱ باشد.`);
        quantities.set(productId, rounded);
      }
      let customerTier: string | null = null;
      if (dto.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: dto.customerId }, select: { tier: true } });
        if (!customer) throw new BadRequestException("مشتری پیدا نشد.");
        customerTier = customer.tier;
      }
      const roundedLines = [...quantities.entries()];
      let total = 0;
      const items = roundedLines.map(([productId, quantity]) => {
        const product = productMap.get(productId)!;
        // Same wholesale rule as checkout — tier OR minimum — so a converted
        // quote cannot silently change price between offer and invoice.
        const unitPrice = product.wholesalePrice != null && (customerTier === "WHOLESALE" || (product.wholesaleMinQty != null && quantity >= product.wholesaleMinQty)) ? product.wholesalePrice : product.price;
        const lineTotal = Math.round(unitPrice * quantity);
        if (lineTotal > 2147483647) throw new BadRequestException("مبلغ یک قلم از سقف مجاز بیشتر است.");
        total += lineTotal;
        return { productId, name: product.name, sku: product.sku, quantity, unitPrice, lineTotal };
      });
      const quoteNo = `QTE-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const quote = await tx.quote.create({
        data: { quoteNo, customerId: dto.customerId || null, note: dto.note?.trim(), total, status: "OPEN", userId: user.id, items: { create: items } },
        include: { items: true, customer: true },
      });
      await tx.auditLog.create({ data: { actor: user.username, action: "QUOTE_CREATE", entity: "Quote", entityId: quote.id, detail: `${quoteNo} / ${total}` } });
      return quote;
    });
  }

  /** تبدیل پیش‌فاکتور به فروش واقعی؛ سپس پیش‌فاکتور CONVERTED می‌شود. */
  @Post(":id/convert")
  async convert(@Param("id") id: string, @Body() dto: ConvertQuoteDto, @CurrentUser() user: SessionUser) {
    // License gate before the transaction opens (an in-transaction check
    // deadlocks on SQLite — see CheckoutService.checkout).
    await this.checkoutService.assertLicensed();
    // ONE transaction: the sale and the quote's OPEN → CONVERTED transition
    // commit together, so a failure between them can never leave an OPEN
    // quote convertible a second time (double sale).
    return this.prisma.$transaction(async (tx) => {
      const quote = await tx.quote.findUnique({ where: { id }, include: { items: true, customer: true } });
      if (!quote) throw new BadRequestException("پیش‌فاکتور پیدا نشد.");
      if (quote.status !== "OPEN") throw new BadRequestException("این پیش‌فاکتور قبلاً تبدیل یا ابطال شده است.");
      if (!quote.items.length) throw new BadRequestException("پیش‌فاکتور خالی است.");
      if (quote.items.some((item) => item.quantity <= 0)) throw new BadRequestException("مقدار یکی از اقلام پیش‌فاکتور معتبر نیست.");
      // A quote for a named customer defaults to credit (the usual "approve
      // now, pay later" flow); anonymous quotes become plain cash sales.
      const paymentMethod = quote.customerId ? "CREDIT" : "CASH";
      // Same checkout pipeline as the POS: prices re-checked, stock deducted,
      // invoice numbered, credit limit enforced. Serialized lines (and kits
      // with serialized components) name their units here — at conversion
      // time, when the devices actually change hands.
      const serialsByItem = new Map<string, string[]>();
      for (const entry of dto.items || []) if (entry.serials?.length) serialsByItem.set(entry.itemId, entry.serials);
      const sale = (await this.checkoutService.checkoutInTx(
        tx,
        { items: quote.items.map((item) => ({ productId: item.productId, quantity: item.quantity, serials: serialsByItem.get(item.id) })), paymentMethod, customerId: quote.customerId || undefined, note: `از پیش‌فاکتور ${quote.quoteNo}` },
        user,
      )) as { id: string };
      const updated = await tx.quote.update({ where: { id }, data: { status: "CONVERTED", saleId: sale.id, convertedAt: new Date() }, include: { items: true } });
      await tx.auditLog.create({ data: { actor: user.username, action: "QUOTE_CONVERT", entity: "Quote", entityId: id, detail: sale.id } });
      return updated;
    });
  }

  @Post(":id/void")
  async void(@Param("id") id: string, @CurrentUser() user: SessionUser) {
    const quote = await this.prisma.quote.findUnique({ where: { id } });
    if (!quote) throw new BadRequestException("پیش‌فاکتور پیدا نشد.");
    if (quote.status !== "OPEN") throw new BadRequestException("این پیش‌فاکتور قابل ابطال نیست.");
    const updated = await this.prisma.quote.update({ where: { id }, data: { status: "VOID" } });
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "QUOTE_VOID", entity: "Quote", entityId: id } });
    return updated;
  }
}

@Module({ controllers: [QuotesController], providers: [CheckoutService] })
export class QuotesModule {}
