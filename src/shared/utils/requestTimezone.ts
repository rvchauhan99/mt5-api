import type { Request } from "express";
import { extractTimezoneHeader, resolveEffectiveTimeZone } from "./timezone";

export function resolveRequestTimeZone(req: Request): string {
  const headerTimeZone =
    extractTimezoneHeader(req.headers["x-user-timezone"]) ??
    extractTimezoneHeader(req.headers["x-timezone"]);
  return resolveEffectiveTimeZone({
    userTimeZone: req.user?.timezone,
    headerTimeZone,
  });
}
