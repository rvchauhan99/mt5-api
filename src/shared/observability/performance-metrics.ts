type RouteMetric = {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  p99Ms: number;
};

const routeBuckets = new Map<string, number[]>();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export function recordRouteLatency(route: string, elapsedMs: number) {
  const bucket = routeBuckets.get(route) ?? [];
  bucket.push(elapsedMs);
  // Bound memory while retaining enough samples for rolling percentiles.
  if (bucket.length > 5000) bucket.splice(0, bucket.length - 5000);
  routeBuckets.set(route, bucket);
}

export function collectRouteMetrics(): Record<string, RouteMetric> {
  const out: Record<string, RouteMetric> = {};
  for (const [route, samples] of routeBuckets.entries()) {
    if (!samples.length) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const totalMs = samples.reduce((sum, val) => sum + val, 0);
    out[route] = {
      count: samples.length,
      totalMs,
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    };
  }
  return out;
}
