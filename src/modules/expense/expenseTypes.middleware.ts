import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/errors/AppError";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { hasJwtPermission } from "../../shared/middlewares/permissionAccess";

const KEYS = [PERMISSIONS.EXPENSE_ADD, PERMISSIONS.EXPENSE_LIST, PERMISSIONS.EXPENSE_AUDIT] as const;

export function expenseTypesReadMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (KEYS.some((k) => hasJwtPermission(req, k))) {
    return next();
  }
  return next(new AppError("auth_error", "Forbidden", 403));
}
