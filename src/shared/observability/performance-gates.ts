import { env } from "../../config/env";
import { collectRouteMetrics } from "./performance-metrics";

export function evaluatePerformanceGates() {
  const routes = collectRouteMetrics();
  const violations = Object.entries(routes)
    .filter(([, metric]) => metric.p95Ms > env.apiP95WarnMs)
    .map(([route, metric]) => ({
      route,
      p95Ms: metric.p95Ms,
      thresholdMs: env.apiP95WarnMs,
    }));

  return {
    ok: violations.length === 0,
    thresholds: {
      apiP95WarnMs: env.apiP95WarnMs,
    },
    violations,
  };
}
