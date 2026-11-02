-- CreateTable
CREATE TABLE IF NOT EXISTS "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#7488a3',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'عدد',
    "price" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "categoryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Supplier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CASHIER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptNo" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "amountPaid" INTEGER NOT NULL,
    "change" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL,
    "note" TEXT,
    "customerId" TEXT,
    "userId" TEXT NOT NULL,
    "cashSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Sale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Sale_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SaleItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "lineTotal" INTEGER NOT NULL,
    CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CashSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openingCash" INTEGER NOT NULL,
    "expectedCash" INTEGER,
    "countedCash" INTEGER,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "CashSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CashMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "cashSessionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashMovement_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Purchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceNo" TEXT,
    "note" TEXT,
    "supplierId" TEXT,
    "userId" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SaleReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnNo" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaleReturn_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SaleReturn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SaleReturnItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleReturnId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "lineTotal" INTEGER NOT NULL,
    CONSTRAINT "SaleReturnItem_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "SaleReturn" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SaleReturnItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomerPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "cashSessionId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CustomerPayment_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CustomerPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SupplierPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SupplierPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Product_barcode_key" ON "Product"("barcode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_name_idx" ON "Product"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Customer_name_idx" ON "Customer"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Customer_phone_idx" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Supplier_name_idx" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Sale_receiptNo_key" ON "Sale"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Sale_createdAt_idx" ON "Sale"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryMovement_productId_createdAt_idx" ON "InventoryMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CashSession_status_openedAt_idx" ON "CashSession"("status", "openedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_entity_createdAt_idx" ON "AuditLog"("entity", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Purchase_createdAt_idx" ON "Purchase"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Purchase_supplierId_idx" ON "Purchase"("supplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SaleReturn_returnNo_key" ON "SaleReturn"("returnNo");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SaleReturn_saleId_idx" ON "SaleReturn"("saleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SaleReturn_createdAt_idx" ON "SaleReturn"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SaleReturnItem_saleReturnId_idx" ON "SaleReturnItem"("saleReturnId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CustomerPayment_customerId_createdAt_idx" ON "CustomerPayment"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierPayment_supplierId_createdAt_idx" ON "SupplierPayment"("supplierId", "createdAt");
