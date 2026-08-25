import { AsyncLocalStorage } from "async_hooks";
import { Request } from "express";

export type AuditContextStore = {
  clientIp?: string;
};

export const auditContext = new AsyncLocalStorage<AuditContextStore>();

export function getAuditContext(): AuditContextStore {
  return auditContext.getStore() ?? {};
}

export function getClientIpFromRequest(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || undefined;
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0]?.trim() || undefined;
  }
  const socketIp = req.socket?.remoteAddress;
  if (socketIp) return socketIp;
  return typeof req.ip === "string" && req.ip ? req.ip : undefined;
}
