import { UnauthorizedException } from "@nestjs/common";
import { AuthController } from "./auth.module";

const sessionUser = { id: "user-1", username: "admin", displayName: "مدیر", role: "ADMIN" as const };

function setup(user: unknown) {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) }, auditLog: { create: jest.fn().mockResolvedValue({}) } };
  return { controller: new AuthController(prisma as never), prisma };
}

describe("Session refresh", () => {
  it("issues a fresh token and session for a still-active user", async () => {
    const { controller } = setup({ ...sessionUser, isActive: true, passwordHash: "x" });
    const result = await controller.refresh(sessionUser);
    expect(result.accessToken).toBeTruthy();
    expect(result.user).toMatchObject({ id: "user-1", username: "admin", role: "ADMIN" });
  });

  it("rejects refresh for a deactivated or deleted user", async () => {
    const deactivated = setup({ ...sessionUser, isActive: false, passwordHash: "x" });
    await expect(deactivated.controller.refresh(sessionUser)).rejects.toBeInstanceOf(UnauthorizedException);
    const deleted = setup(null);
    await expect(deleted.controller.refresh(sessionUser)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
