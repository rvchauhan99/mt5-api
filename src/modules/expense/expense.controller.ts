import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  approveExpense,
  createExpense,
  exportExpensesToBuffer,
  getExpenseDocumentSignedUrl,
  getExpenseById,
  listActiveExpenseTypes,
  listExpenses,
  cancelApprovedExpense,
  rejectExpense,
  uploadExpenseDocuments,
  updateExpense,
} from "./expense.service";
import {
  approveExpenseBodySchema,
  cancelExpenseBodySchema,
  createExpenseBodySchema,
  listExpenseQuerySchema,
  rejectExpenseBodySchema,
  updateExpenseBodySchema,
} from "./expense.validation";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function createExpenseController(req: Request, res: Response) {
  const body = createExpenseBodySchema.parse(req.body);
  const data = await createExpense(body, req.user!.userId, req.requestId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function updateExpenseController(req: Request, res: Response) {
  const body = updateExpenseBodySchema.parse(req.body);
  const id = String(req.params.id);
  const data = await updateExpense(id, body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listExpenseTypesController(_req: Request, res: Response) {
  const data = await listActiveExpenseTypes();
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listExpenseController(req: Request, res: Response) {
  const query = listExpenseQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await listExpenses(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function exportExpenseController(req: Request, res: Response) {
  const query = listExpenseQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportExpensesToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="expenses-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function getExpenseController(req: Request, res: Response) {
  const data = await getExpenseById(String(req.params.id));
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function approveExpenseController(req: Request, res: Response) {
  const body = approveExpenseBodySchema.parse(req.body);
  const data = await approveExpense(String(req.params.id), body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function rejectExpenseController(req: Request, res: Response) {
  const body = rejectExpenseBodySchema.parse(req.body);
  const data = await rejectExpense(
    String(req.params.id),
    { reasonId: body.reasonId, remark: body.remark },
    req.user!.userId,
    req.requestId,
  );
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function cancelExpenseController(req: Request, res: Response) {
  const body = cancelExpenseBodySchema.parse(req.body);
  const data = await cancelApprovedExpense(
    String(req.params.id),
    { reasonId: body.reasonId, remark: body.remark },
    req.user!.userId,
    req.requestId,
  );
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function uploadExpenseDocumentsController(req: Request, res: Response) {
  const id = String(req.params.id);
  const files = Array.isArray(req.files) ? req.files : [];
  const data = await uploadExpenseDocuments(id, files, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function expenseDocumentViewUrlController(req: Request, res: Response) {
  const id = String(req.params.id);
  const docIndex = Number(req.params.docIndex);
  const data = await getExpenseDocumentSignedUrl(id, docIndex);
  res.status(StatusCodes.OK).json({ success: true, data });
}
