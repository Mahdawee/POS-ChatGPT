import { Body, Controller, Get, Post } from "@nestjs/common";
import { IsString, MaxLength, MinLength } from "class-validator";
import { AdminOnly, CurrentUser, Public, type SessionUser } from "../auth";
import { LicenseService } from "./license.service";

export class ActivateLicenseDto {
  // A license block is ~300 chars; headroom for wrapping/notes around it.
  @IsString() @MinLength(30) @MaxLength(4000) licenseText!: string;
}

/**
 * Licensing endpoints. `status` and `activate` are PUBLIC on purpose: the
 * license screen sits before login (a locked shop must be able to enter a
 * license without a session), and activation itself is protected by the
 * Ed25519 signature + machine binding — nothing an attacker can forge.
 * Deactivation requires an admin session so a cashier cannot unlock state.
 */
@Controller("license")
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  @Public()
  @Get("status")
  status() {
    return this.license.status();
  }

  @Public()
  @Post("activate")
  activate(@Body() dto: ActivateLicenseDto) {
    return this.license.activate(dto.licenseText);
  }

  /** Explicit "start the 14-day trial" from the license screen. */
  @Public()
  @Post("trial-start")
  startTrial() {
    return this.license.startTrial();
  }

  @AdminOnly()
  @Post("deactivate")
  deactivate(@CurrentUser() _user: SessionUser) {
    return this.license.deactivate();
  }
}
