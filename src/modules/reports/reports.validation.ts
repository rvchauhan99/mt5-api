import { z } from "zod";

const optionalTrimmed = z
  .string()
  .optional()
  .transform((s) => (typeof s === "string" && s.trim() !== "" ? s.trim() : undefined));

/** Shared filter fields for expense analysis summary + records (aligned with expense list + analysis UI). */
export const expenseAnalysisFilterQuerySchema = z.object({
  search: optionalTrimmed,
  status: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.enum(["pending_audit", "approved", "rejected", "cancelled"]).optional(),
  ),
  expenseTypeId: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  bankId: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  expenseDate_from: optionalTrimmed,
  expenseDate_to: optionalTrimmed,
  expenseDate_op: optionalTrimmed,
  createdAt_from: optionalTrimmed,
  createdAt_to: optionalTrimmed,
  createdAt_op: optionalTrimmed,
  amount: optionalTrimmed,
  amount_to: optionalTrimmed,
  amount_op: optionalTrimmed,
  createdBy: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  approvedBy: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
});

export const expenseAnalysisSummaryQuerySchema = expenseAnalysisFilterQuerySchema;

export const expenseAnalysisRecordsQuerySchema = expenseAnalysisFilterQuerySchema.extend({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  sortBy: z
    .enum(["createdAt", "expenseDate", "amount", "status", "bankName"])
    .default("expenseDate"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const exportExpenseAnalysisQuerySchema = expenseAnalysisRecordsQuerySchema.omit({
  page: true,
  pageSize: true,
});

export const transactionHistoryQuerySchema = z.object({
  fromDate: optionalTrimmed,
  toDate: optionalTrimmed,
  search: optionalTrimmed,
  entity: optionalTrimmed,
  action: optionalTrimmed,
  actorId: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
});

export const exportTransactionHistoryQuerySchema = transactionHistoryQuerySchema.omit({
  page: true,
  pageSize: true,
});

export const dashboardSummaryQuerySchema = z.object({
  fromDate: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ),
  toDate: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ),
  exchangeId: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  status: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.enum(["all", "pending", "approved", "rejected"]).optional(),
  ),
  transactionType: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.enum(["all", "deposit", "withdrawal", "expense"]).optional(),
  ),
  playerId: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  bankId: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.string().length(24).optional(),
  ),
  amountFrom: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().nonnegative().optional(),
  ),
  amountTo: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().nonnegative().optional(),
  ),
  search: optionalTrimmed,
});
