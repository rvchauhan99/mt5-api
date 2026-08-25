import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/errors/AppError";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { hasJwtPermission } from "../../shared/middlewares/permissionAccess";

/** finalize: final edit; reject: exchange or final edit */
export function withdrawalStatusPermissionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const status = req.body?.status as string | undefined;

  if (status === "finalized") {
    if (!hasJwtPermission(req, PERMISSIONS.WITHDRAWAL_FINAL_VIEW)) {
      return next(new AppError("auth_error", "Forbidden", 403));
    }
    return next();
  }

  if (status === "rejected") {
    if (
      !hasJwtPermission(req, PERMISSIONS.WITHDRAWAL_EXCHANGE) &&
      !hasJwtPermission(req, PERMISSIONS.WITHDRAWAL_FINAL_VIEW) &&
      !hasJwtPermission(req, PERMISSIONS.WITHDRAWAL_BANKER)
    ) {
      return next(new AppError("auth_error", "Forbidden", 403));
    }
    return next();
  }

  return next(new AppError("validation_error", "Invalid status for this endpoint", 400));
}
