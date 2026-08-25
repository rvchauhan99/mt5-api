import IORedis from "ioredis";
import { env } from "../../config/env";
import { logger } from "../logger";

let redisClient: IORedis | null = null;
let redisQueueClient: IORedis | null = null;
let redisClientConnectPromise: Promise<void> | null = null;

/** Coalesces concurrent connect() on the lazy singleton (ioredis rejects parallel connect). */
export async function ensureRedisClientConnected(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  if (redis.status === "ready") return;
  redisClientConnectPromise ??= redis.connect().finally(() => {
    redisClientConnectPromise = null;
  });
  await redisClientConnectPromise;
}

export function getRedisClient(): IORedis | null {
  if (!env.redisUrl) return null;
  if (!redisClient) {
    redisClient = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    redisClient.on("error", (err) => {
      logger.warn({ err }, "Redis client error");
    });
  }
  return redisClient;
}

export function getRedisQueueClient(): IORedis | null {
  if (!env.redisUrl) return null;
  if (!redisQueueClient) {
    redisQueueClient = new IORedis(env.redisUrl, {
      // BullMQ requires this for blocking commands used by workers.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    redisQueueClient.on("error", (err) => {
      logger.warn({ err }, "Redis queue client error");
    });
  }
  return redisQueueClient;
}
