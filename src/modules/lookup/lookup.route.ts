import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import {
  getExchangeRateLookupController,
  getPlayerBonusProfileLookupController,
  listBankLookupController,
  listExchangeLookupController,
  listExpenseTypeLookupController,
  listPaymentMethodLookupController,
  listPlayerLookupController,
} from "./lookup.controller";
import { lookupPermissionMiddleware } from "./lookupPermission.middleware";

const lookupRouter = Router();

lookupRouter.use(authMiddleware);

lookupRouter.get("/banks", lookupPermissionMiddleware("banks"), listBankLookupController);
lookupRouter.get(
  "/expense-types",
  lookupPermissionMiddleware("expenseTypes"),
  listExpenseTypeLookupController,
);
lookupRouter.get(
  "/payment-methods",
  lookupPermissionMiddleware("paymentMethods"),
  listPaymentMethodLookupController,
);
lookupRouter.get("/players", lookupPermissionMiddleware("players"), listPlayerLookupController);
lookupRouter.get(
  "/players/:id/bonus-profile",
  lookupPermissionMiddleware("players"),
  getPlayerBonusProfileLookupController,
);
lookupRouter.get("/exchanges", lookupPermissionMiddleware("exchanges"), listExchangeLookupController);
/** Any authenticated user — needed to default FX on money forms */
lookupRouter.get("/exchange-rate", getExchangeRateLookupController);

export { lookupRouter };
