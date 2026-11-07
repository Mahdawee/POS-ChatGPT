import * as bcrypt from "bcryptjs";
import { PrismaClient, UserRole } from "@prisma/client";

export async function ensureInitialData(prisma: PrismaClient) {
  if (await prisma.user.count() > 0) return;
  const passwordHash = await bcrypt.hash("admin12345", 12);
  const admin = await prisma.user.create({ data: { username: "admin", displayName: "مدیر فروشگاه", passwordHash, role: UserRole.ADMIN, mustChangePassword: true } });
  const foods = await prisma.category.create({ data: { name: "مواد غذایی", color: "#6f9f77" } });
  const house = await prisma.category.create({ data: { name: "لوازم خانه", color: "#c98c5b" } });
  const drinks = await prisma.category.create({ data: { name: "نوشیدنی", color: "#729bc4" } });
  const products = [
    { sku: "G-1001", barcode: "1001000001", name: "برنج باسمتی (۱ کیلو)", unit: "بسته", price: 145, cost: 112, stock: 28, minStock: 5, categoryId: foods.id },
    { sku: "G-1002", barcode: "1001000002", name: "روغن آفتابگردان (۱ لیتر)", unit: "بوتل", price: 98, cost: 76, stock: 19, minStock: 5, categoryId: foods.id },
    { sku: "D-2001", barcode: "2001000001", name: "آب معدنی (۱.۵ لیتر)", unit: "بوتل", price: 25, cost: 14, stock: 4, minStock: 8, categoryId: drinks.id },
    { sku: "H-3001", barcode: "3001000001", name: "صابون دست‌شویی", unit: "عدد", price: 32, cost: 21, stock: 42, minStock: 10, categoryId: house.id },
    { sku: "G-1003", barcode: "1001000003", name: "چای سبز (۲۵ پاکت)", unit: "بسته", price: 120, cost: 90, stock: 13, minStock: 4, categoryId: foods.id },
    { sku: "D-2002", barcode: "2001000002", name: "نوشابه قوطی", unit: "عدد", price: 35, cost: 24, stock: 31, minStock: 8, categoryId: drinks.id },
  ];
  for (const item of products) {
    const product = await prisma.product.create({ data: item });
    if (item.stock) await prisma.inventoryMovement.create({ data: { productId: product.id, type: "ADJUSTMENT_IN", quantity: item.stock, stockAfter: item.stock, note: "موجودی نمونه آغازین" } });
  }
  await prisma.customer.create({ data: { id: "walk-in-customer", name: "مشتری گذری" } });
  await prisma.supplier.create({ data: { id: "sample-supplier", name: "تأمین‌کننده نمونه" } });
  await prisma.cashSession.create({ data: { openingCash: 0, userId: admin.id, note: "صندوق آغازین" } });
  const defaults: Record<string, string> = { shopName: "فروشگاه من", currency: "AFN", locale: "fa-AF", lowStockThreshold: "5", receiptFooter: "از خرید شما سپاس‌گزاریم" };
  for (const [key, value] of Object.entries(defaults)) await prisma.setting.create({ data: { key, value } });
}
