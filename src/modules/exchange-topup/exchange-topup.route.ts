import { Router } from "express";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { validate } from "../../shared/middlewares/validate.middleware";
import { createExchangeTopupController, exportExchangeTopupController, listExchangeTopupController } from "./exchange-topup.controller";
import { createExchangeTopupBodySchema, listExchangeTopupQuerySchema } from "./exchange-topup.validation";

const exchangeTopupRouter = Router();

exchangeTopupRouter.use(authMiddleware);

exchangeTopupRouter.post(
  "/",
  permissionMiddleware(PERMISSIONS.EXCHANGE_TOPUP_ADD),
  validate({ body: createExchangeTopupBodySchema }),
  createExchangeTopupController,
);

exchangeTopupRouter.get(
  "/",
  permissionMiddleware(PERMISSIONS.EXCHANGE_TOPUP_LIST),
  validate({ query: listExchangeTopupQuerySchema }),
  listExchangeTopupController,
);

exchangeTopupRouter.get(
  "/export",
  permissionMiddleware(PERMISSIONS.EXCHANGE_TOPUP_LIST),
  validate({ query: listExchangeTopupQuerySchema }),
  exportExchangeTopupController,
);

export { exchangeTopupRouter };
