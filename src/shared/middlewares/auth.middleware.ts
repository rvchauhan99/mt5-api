import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError";
import { verifyAccessToken } from "../utils/jwt";

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next(new AppError("auth_error", "Missing or invalid authorization header", 401));
  }
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new AppError("auth_error", "Invalid token", 401));
  }
}
