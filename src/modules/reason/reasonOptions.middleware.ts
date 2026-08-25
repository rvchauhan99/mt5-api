import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/errors/AppError";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { REASON_TYPES, type ReasonType } from "../../shared/constants/reasonTypes";
import { hasJwtPermission } from "../../shared/middlewares/permissionAccess";

const REASON_TYPE_PERMISSION: Record<ReasonType, string> = {
  [REASON_TYPES.DEPOSIT_EXCHANGE_REJECT]: PERMISSIONS.DEPOSIT_EXCHANGE,
  [REASON_TYPES.WITHDRAWAL_BANKER_REJECT]: PERMISSIONS.WITHDRAWAL_BANKER,
  [REASON_TYPES.EXPENSE_AUDIT_REJECT]: PERMISSIONS.EXPENSE_AUDIT,
  [REASON_TYPES.EXPENSE_CANCEL]: PERMISSIONS.EXPENSE_LIST,
  [REASON_TYPES.DEPOSIT_FINAL_AMEND]: PERMISSIONS.DEPOSIT_FINAL_VIEW,
  [REASON_TYPES.WITHDRAWAL_FINAL_AMEND]: PERMISSIONS.WITHDRAWAL_FINAL_VIEW,
};

/** Ensures the user may load rejection reasons for the requested `reasonType` query param. */
export function reasonOptionsPermissionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const raw = req.query.reasonType;
  const reasonType = typeof raw === "string" ? raw.trim() : "";
  const required = REASON_TYPE_PERMISSION[reasonType as ReasonType];
  if (!required) {
    return next(new AppError("validation_error", "Invalid or missing reasonType", 400));
  }
  if (!hasJwtPermission(req, required)) {
    return next(new AppError("auth_error", "Forbidden", 403));
  }
  return next();
}
