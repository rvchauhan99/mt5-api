import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { validate } from "../../shared/middlewares/validate.middleware";
import { AppError } from "../../shared/errors/AppError";
import { UserModel } from "../users/user.model";
import { getPlatformSettingsController, setPlatformCurrencyController } from "./settings.controller";
import { setPlatformCurrencyBodySchema } from "./settings.validation";
import type { NextFunction, Request, Response } from "express";

const settingsRouter = Router();

/** superadmin or admin may lock platform currency once */
async function requireAdminOrSuperadmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return next(new AppError("auth_error", "Unauthorized", 401));
    }
    const user = await UserModel.findById(userId).select("role status").lean().exec();
    if (!user || user.status !== "active") {
      return next(new AppError("auth_error", "Forbidden", 403));
    }
    if (user.role !== "superadmin" && user.role !== "admin") {
      return next(new AppError("auth_error", "Only admin or superadmin can set platform currency", 403));
    }
    next();
  } catch (err) {
    next(err);
  }
}

settingsRouter.get("/platform", authMiddleware, getPlatformSettingsController);
settingsRouter.put(
  "/platform/currency",
  authMiddleware,
  requireAdminOrSuperadmin,
  validate({ body: setPlatformCurrencyBodySchema }),
  setPlatformCurrencyController,
);

export { settingsRouter };
