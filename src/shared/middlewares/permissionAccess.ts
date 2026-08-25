import type { Request } from "express";

export function isSuperadminRole(role: string | undefined): boolean {
  return role === "superadmin";
}

/** Uses JWT payload (`req.user`). Superadmin bypasses permission checks. */
export function hasJwtPermission(req: Request, requiredPermission: string): boolean {
  const role = req.user?.role;
  if (isSuperadminRole(role)) return true;
  return (req.user?.permissions ?? []).includes(requiredPermission);
}
