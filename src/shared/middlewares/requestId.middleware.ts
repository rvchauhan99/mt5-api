import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.requestId = req.header("x-request-id") ?? randomUUID();
  next();
}
