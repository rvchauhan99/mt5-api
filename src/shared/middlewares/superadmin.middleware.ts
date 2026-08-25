import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError";
import { UserModel } from "../../modules/users/user.model";

/**
 * Requires authMiddleware first. Loads the user from DB and allows only active superadmin.
 */
export async function requireSuperadminMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return next(new AppError("auth_error", "Unauthorized", 401));
    }

    const user = await UserModel.findById(userId).select("role status").lean().exec();
    if (!user || user.status !== "active") {
      return next(new AppError("auth_error", "Forbidden", 403));
    }
    if (user.role !== "superadmin") {
      return next(new AppError("auth_error", "Forbidden", 403));
    }

    next();
  } catch (err) {
    next(err);
  }
}
