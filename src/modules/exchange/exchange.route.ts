import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { validate } from "../../shared/middlewares/validate.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import {
  createExchangeController,
  exchangeStatementController,
  exportExchangeController,
  getExchangeController,
  listExchangeController,
  updateExchangeController,
} from "./exchange.controller";
import {
  createExchangeBodySchema,
  exchangeIdParamSchema,
  exchangeStatementQuerySchema,
  listExchangeQuerySchema,
  updateExchangeBodySchema,
} from "./exchange.validation";

const exchangeRouter = Router();

exchangeRouter.use(authMiddleware);

exchangeRouter.post(
  "/",
  permissionMiddleware(PERMISSIONS.EXCHANGE_ADD),
  validate({ body: createExchangeBodySchema }),
  createExchangeController,
);
exchangeRouter.get(
  "/",
  permissionMiddleware(PERMISSIONS.EXCHANGE_LIST),
  validate({ query: listExchangeQuerySchema }),
  listExchangeController,
);
exchangeRouter.get(
  "/export",
  permissionMiddleware(PERMISSIONS.EXCHANGE_LIST),
  validate({ query: listExchangeQuerySchema }),
  exportExchangeController,
);
exchangeRouter.get(
  "/:id/statement",
  permissionMiddleware(PERMISSIONS.EXCHANGE_STATEMENT),
  validate({ params: exchangeIdParamSchema, query: exchangeStatementQuerySchema }),
  exchangeStatementController,
);
exchangeRouter.get(
  "/:id",
  permissionMiddleware(PERMISSIONS.EXCHANGE_LIST),
  validate({ params: exchangeIdParamSchema }),
  getExchangeController,
);
exchangeRouter.patch(
  "/:id",
  permissionMiddleware(PERMISSIONS.EXCHANGE_LIST),
  validate({ params: exchangeIdParamSchema, body: updateExchangeBodySchema }),
  updateExchangeController,
);

export { exchangeRouter };
