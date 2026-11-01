import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { LocalAuthGuard } from "./auth";
import { PrismaModule } from "./prisma.module";
import { AuthController, AuthModule } from "./modules/auth.module";
import { CatalogModule } from "./modules/catalog.module";
import { ContactsModule } from "./modules/contacts.module";
import { InventoryModule } from "./modules/inventory.module";
import { SalesModule } from "./modules/sales.module";
import { CashModule } from "./modules/cash.module";
import { UsersModule } from "./modules/users.module";
import { SettingsModule } from "./modules/settings.module";
import { DashboardModule } from "./modules/dashboard.module";

@Module({
  imports: [PrismaModule, AuthModule, CatalogModule, ContactsModule, InventoryModule, SalesModule, CashModule, UsersModule, SettingsModule, DashboardModule],
  providers: [{ provide: APP_GUARD, useClass: LocalAuthGuard }],
})
export class AppModule {}
