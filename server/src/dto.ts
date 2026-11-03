import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

export class LoginDto {
  @IsString() @MinLength(1) @MaxLength(40) username!: string;
  @IsString() @MinLength(1) @MaxLength(100) password!: string;
}
export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(100) currentPassword!: string;
  @IsString() @MinLength(8) @MaxLength(100) newPassword!: string;
}
export class CategoryDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsString() color?: string;
}
export class ProductDto {
  @IsString() @MinLength(1) @MaxLength(40) sku!: string;
  @IsOptional() @IsString() @MaxLength(80) barcode?: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(24) unit?: string;
  @IsOptional() @IsBoolean() isWeighted?: boolean;
  /** Kit/BOM: selling this product deducts its components instead. */
  @IsOptional() @IsBoolean() isBundle?: boolean;
  /** Each unit is tracked by serial/IMEI (purchase → sale → return). */
  @IsOptional() @IsBoolean() isSerialized?: boolean;
  @IsOptional() @IsString() @MaxLength(10) expiryDate?: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) price!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) wholesalePrice?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) wholesaleMinQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) cost?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) stock?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) minStock?: number;
  @IsOptional() @IsString() categoryId?: string;
}
export class ContactDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Customers only: 0 disables the credit-limit warning. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(999999999) creditLimit?: number;
  /** Customers only: WHOLESALE tier buys at the wholesale price at any qty. */
  @IsOptional() @IsIn(["RETAIL", "WHOLESALE"]) tier?: "RETAIL" | "WHOLESALE";
}
export class SaleLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
  /** Optional per-line discount in whole afghani. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) discount?: number;
  /** Serialized products: the serial/IMEI of every unit handed over. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) serials?: string[];
}
export class SaleDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SaleLineDto) items!: SaleLineDto[];
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) discount?: number;
  /** Percentage alternative to the flat `discount` (0–100). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) discountPercent?: number;
  @IsEnum(["CASH", "MOBILE", "CREDIT", "WALLET"]) paymentMethod!: "CASH" | "MOBILE" | "CREDIT" | "WALLET";
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) amountPaid?: number;
  /** Mixed payment: cash and mobile portions; the remainder becomes credit. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) splitCash?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) splitMobile?: number;
  /** ADMIN-only flag to complete a sale that exceeds the customer's credit limit. */
  @IsOptional() @IsBoolean() overrideCreditLimit?: boolean;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class InventoryAdjustmentDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Max(2147483647) @Min(-2147483647) quantity!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class OpenCashDto {
  // Cash amounts are capped far below the 32-bit integer limit (≈2.1 billion)
  // so that opening cash + movements + cash sales can never overflow the
  // stored expectedCash column (Prisma P2023) even with several entries.
  @Type(() => Number) @IsInt() @Min(0) @Max(999999999) openingCash!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class CashMovementDto {
  @IsEnum(["IN", "OUT"]) type!: "IN" | "OUT";
  // 999,999,999 Afghani (~$14M) is far beyond any real drawer; see OpenCashDto.
  @Type(() => Number) @IsInt() @Min(1) @Max(999999999) amount!: number;
  @IsString() @MinLength(1) @MaxLength(120) description!: string;
}
export class CloseCashDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(999999999) countedCash!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class UserDto {
  @IsString() @MinLength(3) @MaxLength(40) username!: string;
  @IsString() @MinLength(1) @MaxLength(80) displayName!: string;
  @IsString() @MinLength(8) @MaxLength(100) password!: string;
  @IsEnum(["ADMIN", "CASHIER"]) role!: "ADMIN" | "CASHIER";
}
export class SettingDto {
  @IsString() @MinLength(1) @MaxLength(60) key!: string;
  // Logos are stored as compact data URLs, so values may be large.
  @IsString() @MaxLength(300000) value!: string;
}
export class PurchaseLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) unitCost?: number;
  /** Optional batch/lot expiry for this delivery — feeds expiry warnings. */
  @IsOptional() @IsString() @MaxLength(10) expiryDate?: string;
  /** Serialized products: the serial/IMEI of every unit that arrived. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) serials?: string[];
}
export class PurchaseDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchaseLineDto) items!: PurchaseLineDto[];
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() @MaxLength(60) invoiceNo?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) paidAmount?: number;
}
export class ReturnLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
  /** Serialized products: which exact units are coming back. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) serials?: string[];
}
export class SaleReturnDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReturnLineDto) items!: ReturnLineDto[];
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class CustomerPaymentDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) amount!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class SupplierPaymentDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) amount!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Pay out of the open register (cash OUT movement), like expenses. */
  @IsOptional() @IsBoolean() fromCash?: boolean;
}
export class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(100) newPassword!: string;
}

export class ImportProductRowDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(40) sku?: string;
  @IsOptional() @IsString() @MaxLength(80) barcode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) price?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) cost?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(2147483647) stock?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(2147483647) minStock?: number;
  @IsOptional() @IsString() @MaxLength(24) unit?: string;
  @IsOptional() @IsBoolean() isWeighted?: boolean;
  /** Kit/BOM: selling this product deducts its components instead. */
  @IsOptional() @IsBoolean() isBundle?: boolean;
  /** Each unit is tracked by serial/IMEI (purchase → sale → return). */
  @IsOptional() @IsBoolean() isSerialized?: boolean;
  @IsOptional() @IsString() @MaxLength(10) expiryDate?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
}
export class ProductImportDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ImportProductRowDto) rows!: ImportProductRowDto[];
}

export class ExpenseDto {
  @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) amount!: number;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsBoolean() fromCash?: boolean;
}
export class PurchaseReturnLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(2147483647) quantity!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) unitCost?: number;
  /** IMEI/serials of the exact units going back to the supplier
   *  (required for serialized products). */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) serials?: string[];
}
export class PurchaseReturnDto {
  @IsOptional() @IsString() purchaseId?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PurchaseReturnLineDto) items!: PurchaseReturnLineDto[];
}

/** Base64 payload of a portable .db backup (Settings → restore). */
export class RestoreBackupDto {
  @IsString() @MinLength(16) data!: string;
}

export class StocktakeLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(2147483647) counted!: number;
}
export class StocktakeDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Apply the differences as stock adjustments right away. */
  @IsOptional() @IsBoolean() apply?: boolean;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => StocktakeLineDto) lines!: StocktakeLineDto[];
}

export class StockTransferDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
  @IsEnum(["TO_BACKROOM", "TO_SALES"]) direction!: "TO_BACKROOM" | "TO_SALES";
}

export class QuoteLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
}
export class QuoteDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => QuoteLineDto) items!: QuoteLineDto[];
}
export class QuoteConvertSerialLineDto {
  @IsString() itemId!: string;
  /** Serialized products (and serialized components of a bundle line):
   *  which exact units are handed over when the quote becomes a sale. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) serials?: string[];
}
export class ConvertQuoteDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => QuoteConvertSerialLineDto) items?: QuoteConvertSerialLineDto[];
}

// ── Round 16: wallet, bundles, serials, installments, orders ──────────────

export class WalletChargeDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(999999999) amount!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Take the money out of the open register when charging the wallet. */
  @IsOptional() @IsBoolean() fromCash?: boolean;
}

export class BundleComponentDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(100000) quantity!: number;
}

export class BundleDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => BundleComponentDto) components!: BundleComponentDto[];
}

export class CreateInstallmentPlanDto {
  @IsString() customerId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(999999999) total!: number;
  /** How many installments to split the total into (2–60). */
  @Type(() => Number) @IsInt() @Min(2) @Max(60) installmentCount!: number;
  /** Days between installment due dates (default 30 = monthly). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) intervalDays?: number;
  /** First due date (YYYY-MM-DD); defaults to intervalDays from today. */
  @IsOptional() @IsString() @MaxLength(10) startDate?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Optional: the sale this plan finances. */
  @IsOptional() @IsString() saleId?: string;
}

export class PayInstallmentDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(999999999) amount!: number;
  @IsOptional() @IsBoolean() fromCash?: boolean;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class OrderLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) discount?: number;
}

export class CreateOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderLineDto) items!: OrderLineDto[];
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class OrderDeliveryLineDto {
  @IsString() lineId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(1000000) quantity!: number;
  /** Serialized products: serials of the units being handed over. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) serials?: string[];
}

export class DeliverOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderDeliveryLineDto) deliveries!: OrderDeliveryLineDto[];
  @IsEnum(["CASH", "MOBILE", "CREDIT", "WALLET"]) paymentMethod!: "CASH" | "MOBILE" | "CREDIT" | "WALLET";
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) amountPaid?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) splitCash?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) splitMobile?: number;
  @IsOptional() @IsBoolean() overrideCreditLimit?: boolean;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
