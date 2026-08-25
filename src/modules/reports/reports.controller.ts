import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  dashboardSummaryQuerySchema,
  expenseAnalysisRecordsQuerySchema,
  expenseAnalysisSummaryQuerySchema,
  transactionHistoryQuerySchema,
} from "./reports.validation";
import {
  exportDashboardSummaryToBuffer,
  exportExpenseAnalysisToBuffer,
  exportTransactionHistoryToBuffer,
  getDashboardSummary,
  getExpenseAnalysisRecords,
  getExpenseAnalysisSummary,
  getTransactionHistory,
  listAuditEntityValuesForTransactions,
} from "./reports.service";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function dashboardSummaryController(req: Request, res: Response) {
  const query = dashboardSummaryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getDashboardSummary(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function exportDashboardReportController(req: Request, res: Response) {
  const query = dashboardSummaryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportDashboardSummaryToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="dashboard-operational-report.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function transactionHistoryController(req: Request, res: Response) {
  const query = transactionHistoryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getTransactionHistory(query, { scope: "transactions", timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: data.rows, meta: data.meta });
}

export async function exportTransactionHistoryController(req: Request, res: Response) {
  const query = transactionHistoryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportTransactionHistoryToBuffer(query, { scope: "transactions", timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="audit-history-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function auditEntitiesController(_req: Request, res: Response) {
  const data = await listAuditEntityValuesForTransactions();
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function expenseAnalysisSummaryController(req: Request, res: Response) {
  const query = expenseAnalysisSummaryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const summary = await getExpenseAnalysisSummary(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, summary });
}

export async function expenseAnalysisRecordsController(req: Request, res: Response) {
  const query = expenseAnalysisRecordsQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await getExpenseAnalysisRecords(query, { timeZone });
  res.status(StatusCodes.OK).json({
    success: true,
    data: result.rows,
    meta: result.meta,
  });
}

export async function exportExpenseAnalysisController(req: Request, res: Response) {
  const query = expenseAnalysisRecordsQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportExpenseAnalysisToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="expense-analysis-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}
