import { BadRequestException, NotFoundException } from "@nestjs/common";
import { decodeProductImage, PRODUCT_IMAGE_MAX_BYTES, ProductsController } from "./catalog.module";

/** آپلود/حذف/خواندن عکس کالا — اعتبارسنجی سخت‌گیرانهٔ ورودی و چرخهٔ
 *  نسخه‌ها، چون عکس‌ها مستقیماً از مرورگر می‌آیند و نباید هیچ فایل
 *  غیرتصویری یا بزرگ راهی به دیتابیس باز کنند. */
describe("Product image endpoints", () => {
  const toDataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;
  // WebP: «RIFF» + طول + «WEBP» + بدنهٔ ساختگی
  const webpBytes = Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 fake-thumbnail-body", "latin1")]);
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("jpeg-body")]);
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);

  function setup(image?: { version: number } | null, stored?: { mime: string; bytes: Buffer } | null) {
    const prisma = {
      product: { findUnique: jest.fn().mockResolvedValue(image === undefined ? { id: "p1" } : image === null ? null : { id: "p1", image: { version: image.version } }) },
      productImage: {
        upsert: jest.fn().mockResolvedValue({ productId: "p1", version: 9 }),
        deleteMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(stored ? { productId: "p1", version: 3, mime: stored.mime, bytes: stored.bytes } : null),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    return { controller: new ProductsController(prisma as never), prisma };
  }

  describe("decodeProductImage", () => {
    it("accepts a real WebP data URL and reports the right mime", () => {
      const image = decodeProductImage(toDataUrl("image/webp", webpBytes));
      expect(image.mime).toBe("image/webp");
      expect(image.bytes.equals(webpBytes)).toBe(true);
    });
    it("accepts JPEG and PNG", () => {
      expect(decodeProductImage(toDataUrl("image/jpeg", jpegBytes)).mime).toBe("image/jpeg");
      expect(decodeProductImage(toDataUrl("image/png", pngBytes)).mime).toBe("image/png");
    });
    it("rejects non-image data URLs (gif)", () => {
      expect(() => decodeProductImage(toDataUrl("image/gif", pngBytes))).toThrow(BadRequestException);
    });
    it("trusts the real magic bytes over the declared mime (content is what gets served)", () => {
      // کلاینت رسمی همیشه mime درست می‌فرستد؛ اگر mismatch رسید، آنچه سرو
      // می‌شود نوعِ واقعیِ فایل است — نه ادعای هدر dataURL.
      expect(decodeProductImage(toDataUrl("image/jpeg", webpBytes)).mime).toBe("image/webp");
      expect(decodeProductImage(toDataUrl("image/webp", jpegBytes)).mime).toBe("image/jpeg");
    });
    it("rejects oversized payloads", () => {
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(PRODUCT_IMAGE_MAX_BYTES + 1)]);
      expect(() => decodeProductImage(toDataUrl("image/jpeg", big))).toThrow(BadRequestException);
    });
    it("rejects plain garbage", () => {
      expect(() => decodeProductImage("این یک عکس نیست")).toThrow(BadRequestException);
      expect(() => decodeProductImage("")).toThrow(BadRequestException);
    });
  });

  describe("POST /products/:id/image", () => {
    it("stores the first image as version 1", async () => {
      const { controller, prisma } = setup(undefined);
      const result = await controller.uploadImage("p1", { data: toDataUrl("image/webp", webpBytes) });
      expect(result).toEqual({ version: 1 });
      expect(prisma.productImage.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { productId: "p1" },
        create: expect.objectContaining({ productId: "p1", version: 1, mime: "image/webp" }),
      }));
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });
    it("bumps the version when an image already exists", async () => {
      const { controller, prisma } = setup({ version: 4 });
      const result = await controller.uploadImage("p1", { data: toDataUrl("image/jpeg", jpegBytes) });
      expect(result).toEqual({ version: 5 });
      expect(prisma.productImage.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: expect.objectContaining({ version: 5, mime: "image/jpeg" }),
      }));
    });
    it("404s for an unknown product and never writes", async () => {
      const { controller, prisma } = setup(null);
      await expect(controller.uploadImage("missing", { data: toDataUrl("image/webp", webpBytes) })).rejects.toThrow(NotFoundException);
      expect(prisma.productImage.upsert).not.toHaveBeenCalled();
    });
    it("400s on invalid image data before touching the database", async () => {
      const { controller, prisma } = setup(undefined);
      await expect(controller.uploadImage("p1", { data: "data:image/gif;base64,R0lGOD" })).rejects.toThrow(BadRequestException);
      expect(prisma.productImage.upsert).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /products/:id/image", () => {
    it("removes the stored image", async () => {
      const { controller, prisma } = setup();
      prisma.productImage.deleteMany.mockResolvedValue({ count: 1 });
      await expect(controller.removeImage("p1")).resolves.toEqual({ ok: true });
      expect(prisma.productImage.deleteMany).toHaveBeenCalledWith({ where: { productId: "p1" } });
    });
    it("404s when the product has no image", async () => {
      const { controller, prisma } = setup();
      prisma.productImage.deleteMany.mockResolvedValue({ count: 0 });
      await expect(controller.removeImage("p1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("GET /products/:id/image", () => {
    const makeResponse = () => {
      const res = { status: jest.fn().mockReturnThis(), setHeader: jest.fn().mockReturnThis(), end: jest.fn() };
      return res as unknown as import("express").Response;
    };
    it("serves the bytes with the stored mime and immutable cache headers", async () => {
      const { controller } = setup(undefined, { mime: "image/webp", bytes: webpBytes });
      const res = makeResponse();
      await controller.getImage("p1", res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/webp");
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=31536000, immutable");
      expect((res as unknown as { end: jest.Mock }).end).toHaveBeenCalledWith(webpBytes);
    });
    it("404s when no image is stored", async () => {
      const { controller } = setup(undefined, null);
      await expect(controller.getImage("p1", makeResponse())).rejects.toThrow(NotFoundException);
    });
  });
});
