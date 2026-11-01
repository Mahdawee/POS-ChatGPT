import { PrismaClient, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { configureLocalStorage } from "../src/storage";

configureLocalStorage();
const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: { username: "admin", displayName: "مدیر فروشگاه", passwordHash: await bcrypt.hash("admin12345", 12), role: UserRole.ADMIN },
  });
  const [grocery, house, drinks] = await Promise.all([
    prisma.category.upsert({ where: { name: "مواد غذایی" }, update: {}, create: { name: "مواد غذایی", color: "#6f9f77" } }),
    prisma.category.upsert({ where: { name: "لوازم خانه" }, update: {}, create: { name: "لوازم خانه", color: "#c98c5b" } }),
    prisma.category.upsert({ where: { name: "نوشیدنی" }, update: {}, create: { name: "نوشیدنی", color: "#729bc4" } }),
  ]);
  const products = [
    { sku: "G-1001", barcode: "1001000001", name: "برنج باسمتی (۱ کیلو)", unit: "بسته", price: 145, cost: 112, stock: 28, minStock: 5, categoryId: grocery.id },
    { sku: "G-1002", barcode: "1001000002", name: "روغن آفتابگردان (۱ لیتر)", unit: "بوتل", price: 98, cost: 76, stock: 19, minStock: 5, categoryId: grocery.id },
    { sku: "D-2001", barcode: "2001000001", name: "آب معدنی (۱.۵ لیتر)", unit: "بوتل", price: 25, cost: 14, stock: 4, minStock: 8, categoryId: drinks.id },
    { sku: "H-3001", barcode: "3001000001", name: "صابون دست‌شویی", unit: "عدد", price: 32, cost: 21, stock: 42, minStock: 10, categoryId: house.id },
    { sku: "G-1003", barcode: "1001000003", name: "چای سبز (۲۵ پاکت)", unit: "بسته", price: 120, cost: 90, stock: 13, minStock: 4, categoryId: grocery.id },
    { sku: "D-2002", barcode: "2001000002", name: "نوشابه قوطی", unit: "عدد", price: 35, cost: 24, stock: 31, minStock: 8, categoryId: drinks.id },
  ];
  for (const item of products) await prisma.product.upsert({ where: { sku: item.sku }, update: {}, create: item });
  await prisma.customer.upsert({ where: { id: "walk-in-customer" }, update: {}, create: { id: "walk-in-customer", name: "مشتری گذری", phone: "" } });
  await prisma.supplier.upsert({ where: { id: "sample-supplier" }, update: {}, create: { id: "sample-supplier", name: "تأمین‌کننده نمونه", phone: "" } });
  const open = await prisma.cashSession.findFirst({ where: { status: "OPEN" } });
  if (!open) await prisma.cashSession.create({ data: { openingCash: 5000, userId: admin.id, note: "صندوق آزمایشی" } });
  const defaults: Record<string, string> = { shopName: "فروشگاه من", currency: "AFN", locale: "fa-AF", lowStockThreshold: "5", receiptFooter: "از خرید شما سپاس‌گزاریم" };
  for (const [key, value] of Object.entries(defaults)) await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  console.log(`Demo data ready. Admin: ${admin.username} / admin12345`);
}

main().finally(() => prisma.$disconnect());
