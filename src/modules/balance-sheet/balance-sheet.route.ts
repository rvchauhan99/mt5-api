import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { validate } from "../../shared/middlewares/validate.middleware";
import {
  balanceSheetController,
  balanceSheetDrilldownController,
  balanceSheetDrilldownExportController,
  balanceSheetExportController,
  balanceSheetGroupsController,
  balanceSheetMovementsController,
  balanceSheetMovementsExportController,
  balanceSheetSummaryController,
  createBalanceSheetSnapshotController,
} from "./balance-sheet.controller";
import {
  balanceSheetDrilldownExportQuerySchema,
  balanceSheetDrilldownQuerySchema,
  balanceSheetExportQuerySchema,
  balanceSheetMovementsQuerySchema,
  balanceSheetQuerySchema,
  balanceSheetSummaryQuerySchema,
  createBalanceSheetSnapshotBodySchema,
} from "./balance-sheet.validation";

const balanceSheetRouter = Router();

balanceSheetRouter.use(authMiddleware);

balanceSheetRouter.get(
  "/",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetQuerySchema }),
  balanceSheetController,
);

balanceSheetRouter.get(
  "/summary",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetSummaryQuerySchema }),
  balanceSheetSummaryController,
);

balanceSheetRouter.get(
  "/export",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetExportQuerySchema }),
  balanceSheetExportController,
);

balanceSheetRouter.get(
  "/groups",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  balanceSheetGroupsController,
);

balanceSheetRouter.get(
  "/drilldown",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetDrilldownQuerySchema }),
  balanceSheetDrilldownController,
);

balanceSheetRouter.get(
  "/drilldown/export",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetDrilldownExportQuerySchema }),
  balanceSheetDrilldownExportController,
);

balanceSheetRouter.get(
  "/movements",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetMovementsQuerySchema }),
  balanceSheetMovementsController,
);

balanceSheetRouter.get(
  "/movements/export",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET),
  validate({ query: balanceSheetMovementsQuerySchema }),
  balanceSheetMovementsExportController,
);

balanceSheetRouter.post(
  "/snapshot",
  permissionMiddleware(PERMISSIONS.REPORTS_BALANCE_SHEET_ADMIN),
  validate({ body: createBalanceSheetSnapshotBodySchema }),
  createBalanceSheetSnapshotController,
);

export { balanceSheetRouter };
