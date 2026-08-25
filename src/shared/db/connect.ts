import mongoose from "mongoose";
import { env } from "../../config/env";
import { logger } from "../logger";

export async function connectDb() {
  await mongoose.connect(env.mongoUri, {
    maxPoolSize: env.mongoMaxPoolSize,
    minPoolSize: env.mongoMinPoolSize,
    maxConnecting: env.mongoMaxConnecting,
    waitQueueTimeoutMS: env.mongoWaitQueueTimeoutMs,
    socketTimeoutMS: env.mongoSocketTimeoutMs,
    serverSelectionTimeoutMS: env.mongoServerSelectionTimeoutMs,
    ...(env.mongoFamily !== undefined ? { family: env.mongoFamily } : {}),
  });

  if (env.enableMongoSlowQueryLog) {
    try {
      await mongoose.connection.db?.admin().command({
        profile: 1,
        slowms: env.mongoSlowQueryMs,
        sampleRate: 1.0,
      });
      logger.info({ slowQueryMs: env.mongoSlowQueryMs }, "MongoDB profiler enabled for slow query logging");
    } catch (error) {
      logger.warn(
        { error, slowQueryMs: env.mongoSlowQueryMs },
        "MongoDB profiler could not be enabled; continuing without profiler",
      );
    }
  }
  logger.info("MongoDB connected");
}
