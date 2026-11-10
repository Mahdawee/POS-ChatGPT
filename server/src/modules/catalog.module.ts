import { BadRequestException, Body, Controller, Delete, Get, Module, NotFoundException, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AdminOnly, CurrentUser, Public, SessionUser } from "../auth";
import { AUTO_CODE_ATTEMPTS, autoCodeRetryDelay, isAutoCodeRace, serialized } from "../auto-code";
import { BundleDto, CategoryDto, ProductDto, ProductImageDto, ProductImportDto } from "../dto";
import { PrismaService } from "../prisma.service";
import { roundQty } from "../quantities";

/**
 * Prisma's unique-constraint error (P2002) would surface as a raw 500; the
 * cashier only needs to know the code/barcode is already taken.
 */
/** تراکنشی که فقط جدول کالا را می‌خواند — همان TransactionClient پرایسما. */
type ProductTx = { product: { findMany(args: unknown): Promise<Array<{ sku: string }>> } };

/**
 * کد کالای خودکار — کوتاه، خوانا و پیوسته: P-1001، P-1002 …
 * شماره‌ها از ۱۰۰۱ شروع می‌شوند (سبک دستی مغازه‌ها) و همیشه «بزرگ‌ترین
 * شمارهٔ موجود + ۱» گرفته می‌شود تا با کدهای دستی کاربر هم تصادم نکند.
 */
async function nextSku(tx: ProductTx): Promise<string> {
  const rows = await tx.product.findMany({ where: { sku: { startsWith: "P-" } }, select: { sku: true } });
  const max = rows.reduce((acc, row) => {
    const match = /^P-(\d+)$/.exec(row.sku);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 1000);
  return `P-${max + 1}`;
}

function mapProductConflict(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002") {
    const target = JSON.stringify((error as { meta?: unknown }).meta ?? "");
    const field = target.includes("barcode") ? "بارکد" : "کد کالا";
    return new BadRequestException(`این ${field} برای کالای دیگری ثبت شده است.`);
  }
  return error;
}

/** سقف بایت‌های عکس کالا (۲۵۶ کیلوبایت) — کلاینت خودش به ~۲۵۶ پیکسل کوچک
 *  می‌کند، پس این فقط شبکهٔ اطمینان در برابر درخواست دستی است. */
export const PRODUCT_IMAGE_MAX_BYTES = 256 * 1024;

type DecodedProductImage = { mime: "image/webp" | "image/jpeg" | "image/png"; bytes: Buffer };

/** dataURL عکس کالا را اعتبارسنجی و decode می‌کند: نوع باید WebP/JPEG/PNG
 *  باشد، حجم زیر سقف، و magic-byteهای واقعیِ فایل با ادعای هدر بخواند —
 *  تا فایل غیرتصویری که خود را jpeg جا زده رد شود. */
export function decodeProductImage(data: string): DecodedProductImage {
  const trimmed = data.trim();
  if (trimmed.length > 420000) throw new BadRequestException("عکس کالا بیش از حد بزرگ است.");
  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(trimmed);
  if (!match) throw new BadRequestException("فقط تصویر WebP، JPEG یا PNG برای عکس کالا پذیرفته می‌شود.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > PRODUCT_IMAGE_MAX_BYTES) throw new BadRequestException("حجم عکس کالا باید حداکثر ۲۵۶ کیلوبایت باشد.");
  const isWebp = bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isWebp && !isJpeg && !isPng) throw new BadRequestException("محتوای فایل عکس معتبر نیست.");
  return { mime: isWebp ? "image/webp" : isJpeg ? "image/jpeg" : "image/png", bytes };
}

/** ساخت کلید «تازگی» صندوق از یک ردیف شمارش/بیشینه — تابع خالص و تست‌شدنی.
 *  مقادیر تاریخ ممکن است از درایور به شکل Date یا رشته بیایند؛ هر دو به یک
 *  شکل نرمال می‌شوند تا مقایسهٔ رشته‌ای بین دو فراخوانی معتبر بماند. */
export function composePosVersion(row: {
  moveCount: number | bigint; moveMax: string | null;
  productCount: number | bigint; productMaxUpdated: string | Date | null;
  cashCount: number | bigint; cashMaxOpened: string | Date | null; cashMaxClosed: string | Date | null;
  customerCount: number | bigint; customerMaxUpdated: string | Date | null;
}): string {
  const key = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value ?? ""));
  return [
    "movements", String(row.moveCount), key(row.moveMax),
    "products", String(row.productCount), key(row.productMaxUpdated),
    "cash", String(row.cashCount), key(row.cashMaxOpened), key(row.cashMaxClosed),
    "customers", String(row.customerCount), key(row.customerMaxUpdated),
  ].join("|");
}

@Controller("categories")
class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.category.findMany({ include: { _count: { select: { products: true } } }, orderBy: { name: "asc" } }); }
  @Post() async create(@Body() dto: CategoryDto) {
    const item = await this.prisma.category.create({ data: { name: dto.name.trim(), color: dto.color || "#7488a3" } });
    await this.prisma.auditLog.create({ data: { action: "CREATE", entity: "Category", entityId: item.id, detail: item.name } });
    return item;
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: CategoryDto) {
    const item = await this.prisma.category.update({ where: { id }, data: { name: dto.name.trim(), color: dto.color } });
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Category", entityId: id, detail: item.name } });
    return item;
  }
}

@Controller("products")
export class ProductsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list(@Query("archived") archived?: string, @Query("q") q?: string) {
    // Server-side search keeps product lists snappy in warehouses with
    // thousands of rows; the POS still filters its own client-side copy.
    const search = q?.trim();
    const where: { isActive: boolean; OR?: Array<{ name: { contains: string } } | { sku: { contains: string } } | { barcode: { contains: string } }> } = { isActive: archived !== "1" };
    if (search) where.OR = [{ name: { contains: search } }, { sku: { contains: search } }, { barcode: { contains: search } }];
    return this.prisma.product.findMany({ where, include: { category: true, image: { select: { version: true } }, bundleComponents: { include: { component: { select: { id: true, name: true, sku: true, unit: true, stock: true, reserved: true, isSerialized: true } } } }, serialUnits: { where: { status: "IN_STOCK" }, select: { id: true } } }, orderBy: { name: "asc" } });
  }
  /** لیست سبک برای صفحهٔ صندوق — فقط فیلدهایی که فروشِ سریع لازم دارد:
   *  جست‌وجو (نام/بارکد/کد)، قیمت (شامل عمده)، موجودیِ آزاد (رزرو/بسته) و
   *  سریال‌دار بودن. نسخهٔ کامل /products دستهٔ کامل، شمارهٔ سریال‌های
   *  موجود و ستون‌های مدیریتی را هم می‌فرستد؛ با کاتالوگ چند-هزارتایی
   *  پاسخِ این نسخه چند برابر کوچک‌تر است و صندوق سریع‌تر باز می‌شود.
   *  شمارهٔ سریال‌ها لازم نیست — صندوق آنها را جداگانه و فقط برای کالاهای
   *  سریال‌دارِ داخل سبد می‌خواند (/inventory/serials). */
  /** کلید «تازگی» داده‌های صندوق برای حالت چند-دستگاهی (شبکه). هر تغییری در
   *  کاتالوگ/موجودی، شمارش انبار (cardex)، وضعیت صندوق پول یا مشتری‌ها این
   *  کلید را عوض می‌کند؛ دستگاه‌های دیگر هر چند ثانیه همین یک رشتهٔ سبک را
   *  می‌پرسند و فقط وقتی عوض شده باشد کل لیست را دوباره می‌گیرند — پس
   *  کاهش موجودیِ فروش روی یک دستگاه، روی دستگاه دیگر هم دیده می‌شود. */
  @Get("pos/version") async posVersion() {
    const rows = await this.prisma.$queryRaw<Array<{
      moveCount: number | bigint; moveMax: string | null;
      productCount: number | bigint; productMaxUpdated: string | Date | null;
      cashCount: number | bigint; cashMaxOpened: string | Date | null; cashMaxClosed: string | Date | null;
      customerCount: number | bigint; customerMaxUpdated: string | Date | null;
    }>>`SELECT
        (SELECT COUNT(*) FROM InventoryMovement) AS moveCount,
        (SELECT COALESCE(MAX(id), '') FROM InventoryMovement) AS moveMax,
        (SELECT COUNT(*) FROM Product) AS productCount,
        (SELECT COALESCE(MAX(updatedAt), '') FROM Product) AS productMaxUpdated,
        (SELECT COUNT(*) FROM CashSession) AS cashCount,
        (SELECT COALESCE(MAX(openedAt), '') FROM CashSession) AS cashMaxOpened,
        (SELECT COALESCE(MAX(closedAt), '') FROM CashSession) AS cashMaxClosed,
        (SELECT COUNT(*) FROM Customer) AS customerCount,
        (SELECT COALESCE(MAX(updatedAt), '') FROM Customer) AS customerMaxUpdated`;
    return { version: composePosVersion(rows[0]) };
  }
  @Get("pos") posList() {
    return this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true, sku: true, barcode: true, name: true, unit: true,
        isWeighted: true, isBundle: true, isSerialized: true, reserved: true,
        expiryDate: true, price: true, wholesalePrice: true, wholesaleMinQty: true,
        cost: true, stock: true, minStock: true, categoryId: true,
        category: { select: { id: true, name: true, color: true } },
        image: { select: { version: true } },
        bundleComponents: { select: { id: true, componentId: true, quantity: true, component: { select: { id: true, name: true, sku: true, unit: true, stock: true, reserved: true, isSerialized: true } } } },
      },
    });
  }
  /** Paged variant of list() for the management table: same filters, but only
   *  one page of rows plus the total, so a 10k-item warehouse never ships the
   *  whole catalog (or renders it) at once. Consumers that need everything
   *  (POS local copy, purchase pickers) keep using GET /products.
   *  Shopkeeper requests from months of use: sort by price/stock (not just
   *  name) and jump straight to low- or out-of-stock goods. */
  @Get("page") async page(
    @Query("archived") archived?: string, @Query("q") q?: string, @Query("skip") skip?: string,
    @Query("sort") sort?: string, @Query("dir") dir?: string,
    @Query("stock") stock?: string, @Query("categoryId") categoryId?: string,
  ) {
    const search = q?.trim();
    const where: { isActive: boolean; OR?: Array<{ name: { contains: string } } | { sku: { contains: string } } | { barcode: { contains: string } }>; categoryId?: string } = { isActive: archived !== "1" };
    if (search) where.OR = [{ name: { contains: search } }, { sku: { contains: search } }, { barcode: { contains: search } }];
    if (categoryId) where.categoryId = categoryId;
    // Sortable columns are whitelisted — the value also reaches raw SQL below,
    // so an unknown name must never pass through.
    const column = (["name", "sku", "price", "stock", "cost", "expiry"] as const).includes(sort as "name" | "sku" | "price" | "stock" | "cost" | "expiry") ? sort : "name";
    const direction: "asc" | "desc" = dir === "desc" ? "desc" : "asc";
    const orderBy = column === "stock" ? { stock: direction } : column === "price" ? { price: direction } : column === "cost" ? { cost: direction } : column === "sku" ? { sku: direction } : column === "expiry" ? { expiryDate: { sort: direction, nulls: "last" as const } } : { name: direction };
    const take = 100;
    const offset = Math.max(0, Number(skip) || 0);
    const include = { category: true, image: { select: { version: true } }, bundleComponents: { include: { component: { select: { id: true, name: true, sku: true, unit: true, stock: true, reserved: true, isSerialized: true } } } }, serialUnits: { where: { status: "IN_STOCK" }, select: { id: true } } } as const;
    // Effective on-hand stock as a SQL expression: plain products are their
    // own stock, bundles are how many kits their components can build —
    // floor(min(component.free / qty)) — matching the client's buildableKits.
    // Sorting or filtering by stock must use this value, otherwise every
    // bundle (own stock 0 by design) would sort as empty and never light up
    // the low/out filters even when its parts run dry.
    const effectiveStock = `(CASE WHEN Product.isBundle = 1 THEN COALESCE((
      SELECT MIN(CASE WHEN bc.quantity > 0 THEN CAST((c.stock - c.reserved) / bc.quantity AS INTEGER) ELSE 0 END)
      FROM BundleComponent bc JOIN Product c ON c.id = bc.componentId
      WHERE bc.bundleId = Product.id
    ), 0) ELSE Product.stock END)`;
    // "کم‌موجود / ناموجود" compare two COLUMNS (stock vs minStock), which
    // Prisma's where cannot express — and stock sorting needs the bundle-aware
    // expression above — so those requests resolve the id window in raw SQL
    // first, then hydrate it through the same include as everyone else.
    if (stock === "low" || stock === "out" || column === "stock") {
      // The Prisma branch below reads isActive: archived !== "1" — active rows
      // by default. The raw id-window must agree: 1 (active) unless archived=1.
      const params: unknown[] = [archived === "1" ? 0 : 1];
      const conditions = ["isActive = ?"];
      if (stock === "low" || stock === "out") conditions.push(`(${effectiveStock}) ${stock === "low" ? "<= minStock" : "<= 0"}`);
      if (search) { conditions.push("(name LIKE ? OR sku LIKE ? OR barcode LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      if (categoryId) { conditions.push("categoryId = ?"); params.push(categoryId); }
      const base = `SELECT id FROM Product WHERE ${conditions.join(" AND ")}`;
      const order = column === "stock" ? ` ORDER BY (${effectiveStock}) ${direction === "desc" ? "DESC" : "ASC"}, name ASC` : ` ORDER BY ${column} ${direction === "desc" ? "DESC" : "ASC"}, name ASC`;
      const [idRows, countRows] = await Promise.all([
        this.prisma.$queryRawUnsafe<Array<{ id: string }>>(`${base}${order} LIMIT ${take} OFFSET ${offset}`, ...params),
        this.prisma.$queryRawUnsafe<Array<{ count: number | bigint }>>(`SELECT COUNT(*) AS count FROM (${base})`, ...params),
      ]);
      const ids = idRows.map((row) => row.id);
      const rows = ids.length ? await this.prisma.product.findMany({ where: { id: { in: ids } }, include }) : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const list = ids.map((id) => byId.get(id)).filter((row) => row != null) as typeof rows;
      const total = Number(countRows[0]?.count ?? 0);
      return { list, total, hasMore: offset + list.length < total };
    }
    const [list, total] = await Promise.all([
      this.prisma.product.findMany({ where, include, orderBy, take, skip: offset }),
      this.prisma.product.count({ where }),
    ]);
    return { list, total, hasMore: offset + list.length < total };
  }
  @Post() async create(@Body() dto: ProductDto) {
    if (dto.isBundle && dto.isSerialized) throw new BadRequestException("یک کالا نمی‌تواند هم‌زمان بسته و سریال‌دار باشد؛ بسته اجزایی ساده دارد.");
    const stock = roundQty(dto.stock ?? 0);
    const minStock = roundQty(dto.minStock ?? 0);
    // کالای شمارشی مقدار اعشاری نمی‌گیرد — اعشار فقط برای کالای «وزنی»
    // معنا دارد (فرم هم تنها در حالت وزنی گام ۰٫۰۰۱ نشان می‌دهد). این گارد
    // نبود، چون DTO قبلاً موجودی را @IsInt می‌گرفت و فرمِ کالای وزنی با
    // موجودی اعشاری (مثل ۰٫۳ کیلو) همیشه با خطای اعتبارسنجی رد می‌شد.
    if (!dto.isWeighted) {
      if (!Number.isInteger(stock)) throw new BadRequestException("موجودی اولیهٔ کالای شمارشی باید عدد صحیح باشد؛ برای مقدار اعشاری، نوع کالا را «وزنی» بگذارید.");
      if (!Number.isInteger(minStock)) throw new BadRequestException("حداقل موجودی کالای شمارشی باید عدد صحیح باشد؛ برای مقدار اعشاری، نوع کالا را «وزنی» بگذارید.");
    }
    // کد خودکار → دو ثبتِ همزمان هر دو «بزرگ‌ترین شمارهٔ موجود + ۱» را
    // می‌خوانند؛ قید یکتای sku بازنده را با P2002/P2034 برمی‌گرداند و
    // تلاشِ تازه شمارهٔ درست را می‌گیرد. کد دستی هیچ‌وقت دوباره تلاش
    // نمی‌شود — خطای همان‌جا و با پیام دوستانه برمی‌گردد.
    const autoSku = !dto.sku?.trim();
    for (let attempt = 1; ; attempt++) {
      try {
        return await serialized(() => this.prisma.$transaction(async (tx) => {
          // کد خالی → کد خودکارِ پیوسته؛ صد‌ها کالا بدون تایپِ کد ثبت می‌شوند
          const sku = dto.sku?.trim() || await nextSku(tx as unknown as ProductTx);
          const product = await tx.product.create({ data: { sku, barcode: dto.barcode?.trim() || null, name: dto.name.trim(), unit: dto.unit || "عدد", isWeighted: dto.isWeighted ?? false, isBundle: dto.isBundle ?? false, isSerialized: dto.isSerialized ?? false, expiryDate: dto.expiryDate ? new Date(`${dto.expiryDate}T00:00:00.000Z`) : null, price: dto.price, wholesalePrice: dto.wholesalePrice ?? null, wholesaleMinQty: dto.wholesaleMinQty ?? null, cost: dto.cost ?? 0, stock, minStock, categoryId: dto.categoryId || null } });
          if (stock > 0) await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: stock, stockAfter: stock, note: "موجودی اولیه" } });
          await tx.auditLog.create({ data: { action: "CREATE", entity: "Product", entityId: product.id, detail: product.sku } });
          return product;
        }));
      } catch (error) {
        if (autoSku && attempt < AUTO_CODE_ATTEMPTS && isAutoCodeRace(error, "sku")) { await autoCodeRetryDelay(attempt); continue; }
        throw mapProductConflict(error);
      }
    }
  }
  @Patch(":id") async update(@Param("id") id: string, @Body() dto: ProductDto) {
    const { stock: _stock, ...fields } = dto;
    // The flags are optional on PATCH: judge the request against the stored
    // product, not against absent keys.
    const stored = await this.prisma.product.findUnique({ where: { id }, select: { isBundle: true, isSerialized: true, isWeighted: true } });
    if (!stored) throw new NotFoundException("کالا پیدا نشد.");
    if ((fields.isBundle ?? stored.isBundle) && (fields.isSerialized ?? stored.isSerialized)) throw new BadRequestException("یک کالا نمی‌تواند هم‌زمان بسته و سریال‌دار باشد؛ بسته اجزایی ساده دارد.");
    // همان گارد create: اعشار فقط برای کالای وزنی (حداقل موجودی از PATCH
    // قابل تغییر است؛ موجودی اصلی از مسیر انبار/خرید تغییر می‌کند).
    if (!((fields.isWeighted ?? stored.isWeighted))) {
      if (fields.minStock !== undefined && !Number.isInteger(roundQty(fields.minStock))) throw new BadRequestException("حداقل موجودی کالای شمارشی باید عدد صحیح باشد؛ برای مقدار اعشاری، نوع کالا را «وزنی» بگذارید.");
    }
    if (fields.minStock !== undefined) fields.minStock = roundQty(fields.minStock);
    // Turning a kit back into a plain product drops its BOM in the same
    // transaction — stale rows would silently re-apply if it is ever flipped
    // into a bundle again.
    const item = await this.prisma.$transaction(async (tx) => {
      if (stored.isBundle && fields.isBundle === false) await tx.bundleComponent.deleteMany({ where: { bundleId: id } });
      return tx.product.update({ where: { id }, data: {
      ...fields,
      sku: fields.sku?.trim() || undefined, barcode: fields.barcode?.trim() || null, name: fields.name.trim(), categoryId: fields.categoryId || null,
      // Same normalisation as create: an absent key leaves the date untouched,
      // null clears it (the product form sends null when the field is emptied),
      // and "YYYY-MM-DD" sets it. Passing the raw string through used to work
      // only by Prisma's good graces and could never clear a date.
      expiryDate: fields.expiryDate === undefined ? undefined : fields.expiryDate ? new Date(`${fields.expiryDate}T00:00:00.000Z`) : null,
    } }).catch((error) => { throw mapProductConflict(error); });
    });
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Product", entityId: id, detail: item.sku } });
    return item;
  }
  // ── عکس کالا ──────────────────────────────────────────────────────────
  /** سقف حجم بایت‌های عکس — کلاینت به ~۲۵۶px کوچک می‌کند، پس معمولاً
   *  ۱۵ تا ۶۰ کیلوبایت است؛ سقف فقط شبکهٔ اطمینان است. */
  @Post(":id/image")
  async uploadImage(@Param("id") id: string, @Body() dto: ProductImageDto) {
    const product = await this.prisma.product.findUnique({ where: { id }, select: { id: true, image: { select: { version: true } } } });
    if (!product) throw new NotFoundException("کالا پیدا نشد.");
    const image = decodeProductImage(dto.data);
    // نسخه یک واحد جلو می‌رود و در URL عکس (?v=) می‌نشیند — کش قدیمی
    // هرگز عکس تازه را پنهان نمی‌کند و کشِ immutable بی‌خطر می‌ماند.
    const version = (product.image?.version || 0) + 1;
    await this.prisma.productImage.upsert({
      where: { productId: id },
      create: { productId: id, version, mime: image.mime, bytes: image.bytes },
      update: { version, mime: image.mime, bytes: image.bytes },
    });
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Product", entityId: id, detail: "عکس کالا" } });
    return { version };
  }
  @Delete(":id/image")
  async removeImage(@Param("id") id: string) {
    const removed = await this.prisma.productImage.deleteMany({ where: { productId: id } });
    if (!removed.count) throw new NotFoundException("این کالا عکس ندارد.");
    await this.prisma.auditLog.create({ data: { action: "UPDATE", entity: "Product", entityId: id, detail: "حذف عکس کالا" } });
    return { ok: true };
  }
  /** عکس عمومی است تا خود تگ <img> — که هدر Authorization ندارد — بتواند آن
   *  را بخواند (صرفاً بندانگشتی کالاست، نه دادهٔ مالی). URL نسخه‌دار است،
   *  پس پاسخ با کش یک‌سالهٔ immutable می‌رود و عکسِ جایگزین‌شده دیده می‌شود. */
  @Public()
  @Get(":id/image")
  async getImage(@Param("id") id: string, @Res() response: Response) {
    const image = await this.prisma.productImage.findUnique({ where: { productId: id } });
    if (!image) throw new NotFoundException("عکس پیدا نشد.");
    response.status(200);
    response.setHeader("Content-Type", image.mime);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.end(image.bytes);
  }
  /** اجزای یک بسته/BOM را جایگزین می‌کند (اقلام قبلی پاک می‌شوند). */
  @AdminOnly()
  @Put(":id/bundle")
  async setBundle(@Param("id") id: string, @Body() dto: BundleDto, @CurrentUser() user: SessionUser) {
    return this.prisma.$transaction(async (tx) => {
      const bundle = await tx.product.findUnique({ where: { id } });
      if (!bundle || !bundle.isActive) throw new BadRequestException("کالا پیدا نشد.");
      if (!bundle.isBundle) throw new BadRequestException("ابتدا کالا را به‌عنوان «بسته» ذخیره کنید.");
      if (bundle.isSerialized) throw new BadRequestException("کالای سریال‌دار نمی‌تواند بسته باشد؛ بسته اجزایی ساده دارد.");
      const ids = [...new Set(dto.components.map((row) => row.productId))];
      const components = await tx.product.findMany({ where: { id: { in: ids }, isActive: true } });
      if (components.length !== ids.length) throw new BadRequestException("یکی از اجزای بسته پیدا نشد یا غیرفعال است.");
      for (const component of components) {
        if (component.id === id) throw new BadRequestException("بسته نمی‌تواند جزء خودش باشد.");
        if (component.isBundle) throw new BadRequestException("بسته داخل بسته مجاز نیست.");
      }
      await tx.bundleComponent.deleteMany({ where: { bundleId: id } });
      await tx.bundleComponent.createMany({ data: dto.components.map((row) => ({ bundleId: id, componentId: row.productId, quantity: row.quantity })) });
      await tx.auditLog.create({ data: { actor: user.username, action: "SET_BUNDLE", entity: "Product", entityId: id, detail: `${dto.components.length} جزء` } });
      return tx.product.findUnique({ where: { id }, include: { bundleComponents: { include: { component: { select: { id: true, name: true, sku: true, unit: true, stock: true, reserved: true, isSerialized: true } } } } } });
    });
  }

  @Patch(":id/archive")
  async archive(@Param("id") id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new BadRequestException("کالا پیدا نشد.");
    // Reserved units belong to open pre-orders: archiving the product would
    // leave those orders permanently undeliverable (checkout refuses inactive
    // products) with their reservation locked on the shelf forever.
    if ((product.reserved || 0) > 0) throw new BadRequestException(`«${product.name}» برای سفارش باز رزرو شده و قابل بایگانی نیست؛ نخست سفارش را تحویل یا لغو کنید.`);
    return this.prisma.product.update({ where: { id }, data: { isActive: false } });
  }
  @Patch(":id/restore") async restore(@Param("id") id: string) { return this.prisma.product.update({ where: { id }, data: { isActive: true } }); }

  /** ورود گروهی کالا از فایل CSV/اکسل (برگزیدهٔ CSV) — ایجاد یا به‌روزرسانی بر اساس بارکد/کد/نام */
  @AdminOnly()
  @Post("import")
  async importProducts(@Body() dto: ProductImportDto, @CurrentUser() user: SessionUser) {
    let created = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (const [index, row] of dto.rows.entries()) {
      const name = row.name?.trim();
      if (!name) { errors.push({ row: index + 2, message: "نام کالا خالی است." }); continue; }
      // Bundle/serialized goods need their components/serial lists, which a
      // spreadsheet row cannot carry — silently dropping the flags would
      // create a half-configured product, so the row is rejected with a
      // clear message instead (the product form is the right place).
      if (row.isBundle || row.isSerialized) { errors.push({ row: index + 2, message: "کالای بسته یا سریال‌دار از فایل ورودی پشتیبانی نمی‌شود؛ آن را از فرم «کالای جدید» ثبت کنید." }); continue; }
      try {
        await this.prisma.$transaction(async (tx) => {
          const existing = (row.barcode?.trim() ? await tx.product.findUnique({ where: { barcode: row.barcode.trim() } }) : null)
            || (row.sku?.trim() ? await tx.product.findUnique({ where: { sku: row.sku.trim() } }) : null)
            || (await tx.product.findFirst({ where: { name } }));
          let categoryId: string | null = null;
          if (row.category?.trim()) {
            const category = await tx.category.upsert({ where: { name: row.category.trim() }, create: { name: row.category.trim() }, update: {} });
            categoryId = category.id;
          }
          const expiryDate = row.expiryDate ? new Date(`${row.expiryDate}T00:00:00.000Z`) : null;
          // همان گارد فرم: اعشار فقط برای کالای وزنی — برای سطرِ به‌روزرسانی،
          // پرچم وزنیِ خود کالای موجود هم ملاک است (ستون فایل اختیاری است).
          const effectiveWeighted = row.isWeighted ?? Boolean(existing?.isWeighted);
          if (!effectiveWeighted && ((row.stock !== undefined && !Number.isInteger(row.stock)) || (row.minStock !== undefined && !Number.isInteger(row.minStock)))) {
            const reject = new Error("COUNTED_STOCK_FRACTIONAL");
            reject.name = "ImportReject";
            throw reject;
          }
          if (existing) {
            const nextStock = roundQty(row.stock ?? existing.stock);
            await tx.product.update({ where: { id: existing.id }, data: {
              price: row.price ?? existing.price, cost: row.cost ?? existing.cost,
              minStock: roundQty(row.minStock ?? existing.minStock), stock: nextStock,
              unit: row.unit || existing.unit, isWeighted: row.isWeighted ?? existing.isWeighted,
              expiryDate: row.expiryDate === undefined ? existing.expiryDate : expiryDate,
              categoryId: categoryId || existing.categoryId,
            } });
            // Keep the cardex honest: a stock change coming from the import
            // file is an adjustment like any other, so it gets a movement row
            // too (without it the stock figure and the movement history
            // silently disagreed after an import).
            const stockDelta = roundQty(nextStock - existing.stock);
            if (stockDelta !== 0) await tx.inventoryMovement.create({ data: { productId: existing.id, type: stockDelta > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", quantity: stockDelta, stockAfter: nextStock, note: "ورود از فایل" } });
            updated += 1;
          } else {
            const sku = row.sku?.trim() || await nextSku(tx as unknown as ProductTx);
            const product = await tx.product.create({ data: {
              sku, barcode: row.barcode?.trim() || null, name, unit: row.unit || "عدد",
              isWeighted: row.isWeighted ?? false, expiryDate,
              price: row.price ?? 0, cost: row.cost ?? 0, stock: roundQty(row.stock ?? 0), minStock: roundQty(row.minStock ?? 0), categoryId,
            } });
            if ((row.stock ?? 0) > 0) await tx.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: roundQty(row.stock ?? 0), stockAfter: roundQty(row.stock ?? 0), note: "ورود از فایل" } });
            created += 1;
          }
        });
      } catch (error) {
        errors.push({
          row: index + 2,
          message: error instanceof Error && error.name === "ImportReject"
            ? "موجودی کالای شمارشی باید عدد صحیح باشد؛ برای مقدار اعشاری، نوع کالا را «وزنی» بگذارید."
            : error instanceof Error && error.message.includes("Unique") ? "بارکد یا کد کالا تکراری است." : "ذخیرهٔ این سطر ممکن نشد.",
        });
      }
    }
    await this.prisma.auditLog.create({ data: { actor: user.username, action: "IMPORT_PRODUCTS", entity: "Product", detail: `created=${created}; updated=${updated}; errors=${errors.length}` } });
    return { created, updated, errors };
  }
}

@Module({ controllers: [CategoriesController, ProductsController] })
export class CatalogModule {}
