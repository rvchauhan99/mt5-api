import pinoHttp from "pino-http";
import { logger } from "../logger";

export const httpLoggerMiddleware = pinoHttp({
  logger,
  customProps: (req) => ({ requestId: (req as any).requestId }),
});
