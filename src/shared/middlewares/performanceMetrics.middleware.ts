import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env";
import { recordRouteLatency } from "../observability/performance-metrics";

export function performanceMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!env.enablePerformanceMetrics) {
    next();
    return;
  }

  const startedAtNs = process.hrtime.bigint();
  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
    const route = req.route?.path ? `${req.method} ${req.baseUrl}${req.route.path}` : `${req.method} ${req.path}`;
    recordRouteLatency(route, elapsedMs);
  });
  next();
}
