import { Body, Controller, Get, Module, Param, Patch, Post } from "@nestjs/common";
import { ContactDto } from "../dto";
import { PrismaService } from "../prisma.service";

@Controller("customers")
class CustomersController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.customer.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }); }
  @Post() create(@Body() dto: ContactDto) { return this.prisma.customer.create({ data: { ...dto, name: dto.name.trim() } }); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: ContactDto) { return this.prisma.customer.update({ where: { id }, data: { ...dto, name: dto.name.trim() } }); }
}

@Controller("suppliers")
class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }); }
  @Post() create(@Body() dto: ContactDto) { return this.prisma.supplier.create({ data: { ...dto, name: dto.name.trim() } }); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: ContactDto) { return this.prisma.supplier.update({ where: { id }, data: { ...dto, name: dto.name.trim() } }); }
}

@Module({ controllers: [CustomersController, SuppliersController] })
export class ContactsModule {}
