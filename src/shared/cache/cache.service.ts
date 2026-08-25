import { ensureRedisClientConnected, getRedisClient } from "./redis";
import { logger } from "../logger";

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    await ensureRedisClientConnected();
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, key }, "Cache read failed; falling back to source data");
    return null;
  }
}

export async function setCachedJson(key: string, data: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await ensureRedisClientConnected();
    await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
  } catch (err) {
    logger.warn({ err, key, ttlSeconds }, "Cache write failed; continuing without cache");
  }
}

export async function bumpCacheVersion(namespace: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 1;
  try {
    await ensureRedisClientConnected();
    const key = `cache:version:${namespace}`;
    const next = await redis.incr(key);
    if (next === 1) {
      await redis.expire(key, 60 * 60 * 24 * 30);
    }
    return next;
  } catch (err) {
    logger.warn({ err, namespace }, "Cache version bump failed; continuing with default");
    return 1;
  }
}

export async function getCacheVersion(namespace: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 1;
  try {
    await ensureRedisClientConnected();
    const key = `cache:version:${namespace}`;
    const value = await redis.get(key);
    if (!value) return 1;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } catch (err) {
    logger.warn({ err, namespace }, "Cache version read failed; falling back to default version");
    return 1;
  }
}
