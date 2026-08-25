import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/errors/AppError";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { hasJwtPermission } from "../../shared/middlewares/permissionAccess";

/** List expenses if user can read the list (aligned with sub-admin permission grid). */
export function expenseListPermissionMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (hasJwtPermission(req, PERMISSIONS.EXPENSE_LIST) || hasJwtPermission(req, PERMISSIONS.EXPENSE_AUDIT)) {
    return next();
  }
  return next(new AppError("auth_error", "Forbidden", 403));
}
