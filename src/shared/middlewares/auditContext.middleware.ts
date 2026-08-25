import { NextFunction, Request, Response } from "express";
import { auditContext, getClientIpFromRequest } from "../context/auditContext";

export function auditContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const clientIp = getClientIpFromRequest(req);
  auditContext.run({ clientIp }, () => next());
}
