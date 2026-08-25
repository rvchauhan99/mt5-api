import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import compression from "compression";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { requestIdMiddleware } from "./shared/middlewares/requestId.middleware";
import { auditContextMiddleware } from "./shared/middlewares/auditContext.middleware";
import { httpLoggerMiddleware } from "./shared/middlewares/httpLogger.middleware";
import { performanceMetricsMiddleware } from "./shared/middlewares/performanceMetrics.middleware";
import { errorMiddleware, notFoundMiddleware } from "./shared/middlewares/error.middleware";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: env.apiJsonLimit }));
  app.use(express.urlencoded({ extended: true, limit: env.apiJsonLimit }));
  app.use(compression());
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(auditContextMiddleware);
  app.use(httpLoggerMiddleware);
  app.use(performanceMetricsMiddleware);
  app.use(morgan("dev"));

  app.use("/api/v1", apiRouter);
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
