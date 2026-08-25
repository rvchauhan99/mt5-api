import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/errors/AppError";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { hasJwtPermission } from "../../shared/middlewares/permissionAccess";

type LookupResource = "banks" | "expenseTypes" | "players" | "exchanges";

const LOOKUP_PERMISSION_MAP: Record<LookupResource, string[]> = {
  banks: [
    PERMISSIONS.DEPOSIT_BANKER,
    PERMISSIONS.WITHDRAWAL_BANKER,
    PERMISSIONS.WITHDRAWAL_FINAL_VIEW,
    PERMISSIONS.EXPENSE_ADD,
    PERMISSIONS.EXPENSE_AUDIT,
    PERMISSIONS.LIABILITY_ENTRY_ADD,
    PERMISSIONS.LIABILITY_ENTRY_LIST,
  ],
  expenseTypes: [PERMISSIONS.EXPENSE_ADD, PERMISSIONS.EXPENSE_AUDIT],
  players: [
    PERMISSIONS.DEPOSIT_EXCHANGE,
    PERMISSIONS.WITHDRAWAL_EXCHANGE,
    PERMISSIONS.WITHDRAWAL_BANKER,
    PERMISSIONS.WITHDRAWAL_FINAL_VIEW,
  ],
  exchanges: [PERMISSIONS.PLAYER_ADD, PERMISSIONS.PLAYER_EDIT, PERMISSIONS.DEPOSIT_EXCHANGE],
};

export function lookupPermissionMiddleware(resource: LookupResource) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const requiredPermissions = LOOKUP_PERMISSION_MAP[resource];
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return next(new AppError("auth_error", "Forbidden", 403));
    }
    if (requiredPermissions.some((permission) => hasJwtPermission(req, permission))) {
      return next();
    }
    return next(new AppError("auth_error", "Forbidden", 403));
  };
}

