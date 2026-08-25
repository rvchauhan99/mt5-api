type EnvConfig = {
  nodeEnv: string;
  port: number;
  mongoUri: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  /** Allowlist: one or more origins from `CORS_ORIGIN` (comma-separated). */
  corsOrigin: string[];
  cookieSecure: boolean;
  cookieDomain?: string;

  // Optional External Services
  brevoUser?: string;
  brevoMasterKey?: string;
  brevoFrom: string;

  bucketEndpoint?: string;
  bucketName?: string;
  bucketAccessKeyId?: string;
  bucketSecretAccessKey?: string;
  bucketRegion: string;
  bucketPublicUrlBase?: string;

  // Performance / observability
  mongoMaxPoolSize: number;
  mongoMinPoolSize: number;
  mongoMaxConnecting: number;
  mongoWaitQueueTimeoutMs: number;
  mongoSocketTimeoutMs: number;
  mongoServerSelectionTimeoutMs: number;
  mongoSlowQueryMs: number;
  /** Passed to the driver as `family` (DNS / socket). Set `MONGO_FAMILY=6` to force IPv6. */
  mongoFamily?: 4 | 6;
  enableMongoSlowQueryLog: boolean;
  enablePerformanceMetrics: boolean;
  apiP95WarnMs: number;
  apiJsonLimit: string;

  // Cache / queue
  redisUrl?: string;
};

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseMongoFamily(): 4 | 6 | undefined {
  const raw = process.env.MONGO_FAMILY?.trim();
  if (raw === "4") return 4;
  if (raw === "6") return 6;
  return undefined;
}

function parseCorsOrigin(raw: string | undefined): string[] {
  const fallback = ["http://localhost:3000"];
  if (!raw?.trim()) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  return [...new Set(parts)];
}

export const env: EnvConfig = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/crickierp"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "change_me_access_secret"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "change_me_refresh_secret"),
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  cookieSecure: (process.env.COOKIE_SECURE ?? "false") === "true",
  cookieDomain: process.env.COOKIE_DOMAIN,
  
  // Email config (Optional)
  brevoUser: process.env.BREVO_USER,
  brevoMasterKey: process.env.BREVO_MASTER_KEY,
  brevoFrom: process.env.BREVO_FROM ?? "noreply@crickierp.local",

  // Bucket config (Optional)
  bucketEndpoint: process.env.BUCKET_ENDPOINT,
  bucketName: process.env.BUCKET_NAME,
  bucketAccessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
  bucketSecretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
  bucketRegion: process.env.BUCKET_REGION ?? "auto",
  bucketPublicUrlBase: process.env.BUCKET_PUBLIC_URL_BASE,

  mongoMaxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE ?? 80),
  mongoMinPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE ?? 10),
  mongoMaxConnecting: Number(process.env.MONGO_MAX_CONNECTING ?? 8),
  mongoWaitQueueTimeoutMs: Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS ?? 5000),
  mongoSocketTimeoutMs: Number(process.env.MONGO_SOCKET_TIMEOUT_MS ?? 45000),
  mongoServerSelectionTimeoutMs: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
  mongoSlowQueryMs: Number(process.env.MONGO_SLOW_QUERY_MS ?? 120),
  mongoFamily:
    parseMongoFamily() ??
    ((process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/crickierp").includes(".mongodb.net") ? 4 : undefined),
  enableMongoSlowQueryLog: (process.env.ENABLE_MONGO_SLOW_QUERY_LOG ?? "true") === "true",
  enablePerformanceMetrics: (process.env.ENABLE_PERFORMANCE_METRICS ?? "true") === "true",
  apiP95WarnMs: Number(process.env.API_P95_WARN_MS ?? 500),
  apiJsonLimit: process.env.API_JSON_LIMIT ?? "10mb",
  redisUrl: process.env.REDIS_URL,
};
