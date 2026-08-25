import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError";
import { hasJwtPermission, isSuperadminRole } from "./permissionAccess";

export function permissionMiddleware(requiredPermission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (hasJwtPermission(req, requiredPermission)) {
      return next();
    }
    return next(new AppError("auth_error", "Forbidden", 403));
  };
}

/** Pass if the user has at least one of the given permissions (or is superadmin). */
export function anyPermissionMiddleware(requiredPermissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (isSuperadminRole(role)) {
      return next();
    }
    const permissions = req.user?.permissions ?? [];
    if (requiredPermissions.some((p) => permissions.includes(p))) {
      return next();
    }
    return next(new AppError("auth_error", "Forbidden", 403));
  };
}
