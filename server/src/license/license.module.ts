import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma.module";
import { LicenseController } from "./license.controller";
import { LicenseService } from "./license.service";

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [LicenseController],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicenseModule {}
