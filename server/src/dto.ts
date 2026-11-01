import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

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
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) price!: number;
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
}
export class SaleLineDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) quantity!: number;
}
export class SaleDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SaleLineDto) items!: SaleLineDto[];
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) discount?: number;
  @IsEnum(["CASH", "MOBILE", "CREDIT"]) paymentMethod!: "CASH" | "MOBILE" | "CREDIT";
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) amountPaid?: number;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class InventoryAdjustmentDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() @Max(2147483647) @Min(-2147483647) quantity!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class OpenCashDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) openingCash!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class CashMovementDto {
  @IsEnum(["IN", "OUT"]) type!: "IN" | "OUT";
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) amount!: number;
  @IsString() @MinLength(1) @MaxLength(120) description!: string;
}
export class CloseCashDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) countedCash!: number;
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
  @IsString() @MaxLength(500) value!: string;
}
