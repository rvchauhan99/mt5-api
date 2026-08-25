import { z } from "zod";
import { moneyFxInputSchema, openingMoneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

export const createBankBodySchema = z.object({
  holderName: z.string().min(2),
  bankName: z.string().min(2),
  accountNumber: z.string().min(6),
  ifsc: z.string().min(4),
  openingBalance: z.number().min(0),
  status: z.enum(["active", "deactive"]).default("active"),
}).merge(openingMoneyFxInputSchema);

export const listBankQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z
    .enum(["createdAt", "holderName", "bankName", "accountNumber", "ifsc", "openingBalance", "status"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  holderName: z.string().optional(),
  holderName_op: z.string().optional(),
  bankName: z.string().optional(),
  bankName_op: z.string().optional(),
  accountNumber: z.string().optional(),
  accountNumber_op: z.string().optional(),
  ifsc: z.string().optional(),
  ifsc_op: z.string().optional(),
  status: z.string().optional(),
  createdBy: z.string().optional(),
  createdAt_from: z.string().optional(),
  createdAt_to: z.string().optional(),
  createdAt_op: z.string().optional(),
  openingBalance: z.string().optional(),
  openingBalance_to: z.string().optional(),
  openingBalance_op: z.string().optional(),
});

export const bankLedgerQuerySchema = z.object({
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  entryType: z.enum(["all", "deposit", "withdrawal", "expense", "liability", "settlement"]).default("all"),
});

export const createBankSettlementBodySchema = z.object({
  effectiveAt: z.coerce.date(),
  masterReportedBalance: z.coerce.number().finite().nonnegative(),
  reason: z.string().trim().min(3).max(4000),
});

export const bankIdParamSchema = z.object({
  id: z.string().length(24),
});
