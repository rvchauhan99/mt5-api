import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { validate } from "../../shared/middlewares/validate.middleware";
import { requireSuperadminMiddleware } from "../../shared/middlewares/superadmin.middleware";
import {
  bankLedgerController,
  createBankController,
  createBankSettlementController,
  exportBankController,
  getBankComputedClosingController,
  listBankController,
  listBankSettlementsController,
} from "./bank.controller";
import {
  bankIdParamSchema,
  bankLedgerQuerySchema,
  createBankBodySchema,
  createBankSettlementBodySchema,
  exportBankQuerySchema,
  listBankQuerySchema,
} from "./bank.validation";

const bankRouter = Router();

bankRouter.use(authMiddleware);
bankRouter.post("/", permissionMiddleware(PERMISSIONS.BANK_ADD), validate({ body: createBankBodySchema }), createBankController);
bankRouter.get(
  "/export",
  permissionMiddleware(PERMISSIONS.BANK_LIST),
  validate({ query: exportBankQuerySchema }),
  exportBankController,
);
bankRouter.get(
  "/:id/settlements",
  permissionMiddleware(PERMISSIONS.BANK_STATEMENT),
  validate({ params: bankIdParamSchema }),
  listBankSettlementsController,
);
bankRouter.get(
  "/:id/computed-closing",
  permissionMiddleware(PERMISSIONS.BANK_STATEMENT),
  validate({ params: bankIdParamSchema }),
  getBankComputedClosingController,
);
bankRouter.post(
  "/:id/settlements",
  requireSuperadminMiddleware,
  validate({ params: bankIdParamSchema, body: createBankSettlementBodySchema }),
  createBankSettlementController,
);
bankRouter.get(
  "/:id/ledger",
  permissionMiddleware(PERMISSIONS.BANK_STATEMENT),
  validate({ params: bankIdParamSchema, query: bankLedgerQuerySchema }),
  bankLedgerController,
);
bankRouter.get(
  "/",
  permissionMiddleware(PERMISSIONS.BANK_LIST),
  validate({ query: listBankQuerySchema }),
  listBankController,
);

export { bankRouter };
