import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { validate } from "../../shared/middlewares/validate.middleware";
import {
  dashboardSummaryQuerySchema,
  expenseAnalysisRecordsQuerySchema,
  expenseAnalysisSummaryQuerySchema,
} from "./reports.validation";
import {
   auditEntitiesController,
  dashboardSummaryController,
  exportDashboardReportController,
  exportExpenseAnalysisController,
  exportTransactionHistoryController,
  expenseAnalysisRecordsController,
  expenseAnalysisSummaryController,
  transactionHistoryController,
} from "./reports.controller";

const reportsRouter = Router();

reportsRouter.use(authMiddleware);
reportsRouter.get(
  "/dashboard-summary",
  permissionMiddleware(PERMISSIONS.DASHBOARD_VIEW),
  validate({ query: dashboardSummaryQuerySchema }),
  dashboardSummaryController,
);
reportsRouter.get(
  "/dashboard-summary/export",
  permissionMiddleware(PERMISSIONS.DASHBOARD_VIEW),
  validate({ query: dashboardSummaryQuerySchema }),
  exportDashboardReportController,
);
reportsRouter.get(
  "/transaction-history",
  permissionMiddleware(PERMISSIONS.REPORTS_TRANSACTION_HISTORY),
  transactionHistoryController,
);
reportsRouter.get(
  "/transaction-history/export",
  permissionMiddleware(PERMISSIONS.REPORTS_TRANSACTION_HISTORY),
  exportTransactionHistoryController,
);
reportsRouter.get(
  "/audit-entities",
  permissionMiddleware(PERMISSIONS.REPORTS_TRANSACTION_HISTORY),
  auditEntitiesController,
);
reportsRouter.get(
  "/expense-analysis/summary",
  permissionMiddleware(PERMISSIONS.REPORTS_EXPENSE_ANALYSIS),
  validate({ query: expenseAnalysisSummaryQuerySchema }),
  expenseAnalysisSummaryController,
);
reportsRouter.get(
  "/expense-analysis/records",
  permissionMiddleware(PERMISSIONS.REPORTS_EXPENSE_ANALYSIS),
  validate({ query: expenseAnalysisRecordsQuerySchema }),
  expenseAnalysisRecordsController,
);
reportsRouter.get(
  "/expense-analysis/export",
  permissionMiddleware(PERMISSIONS.REPORTS_EXPENSE_ANALYSIS),
  validate({ query: expenseAnalysisRecordsQuerySchema }),
  exportExpenseAnalysisController,
);

export { reportsRouter };
