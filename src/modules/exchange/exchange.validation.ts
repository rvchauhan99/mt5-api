import { z } from "zod";
import { openingMoneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

export const createExchangeBodySchema = z.object({
  name: z.string().min(2).max(120),
  provider: z.string().min(2).max(120),
  openingBalance: z.number().min(0),
  bonus: z.number().min(0).default(0),
  status: z.enum(["active", "deactive"]).default("active"),
}).merge(openingMoneyFxInputSchema);

export const updateExchangeBodySchema = z.object({
  name: z.string().min(2).max(120).optional(),
  provider: z.string().min(2).max(120).optional(),
  openingBalance: z.number().min(0).optional(),
  bonus: z.number().min(0).optional(),
  status: z.enum(["active", "deactive"]).optional(),
  version: z.number().int().positive(),
}).merge(openingMoneyFxInputSchema.partial());

export const listExchangeQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  sortBy: z.enum(["createdAt", "name", "provider"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  /** Column filters (same keys as crickierp-web exchange list) */
  name: z.string().optional(),
  name_op: z.string().optional(),
  provider: z.string().optional(),
  provider_op: z.string().optional(),
  status: z.string().optional(),
  createdBy: z.string().optional(),
  createdAt_from: z.string().optional(),
  createdAt_to: z.string().optional(),
  createdAt_op: z.string().optional(),
  openingBalance: z.string().optional(),
  openingBalance_to: z.string().optional(),
  openingBalance_op: z.string().optional(),
  currentBalance: z.string().optional(),
  currentBalance_to: z.string().optional(),
  currentBalance_op: z.string().optional(),
  bonus: z.string().optional(),
  bonus_to: z.string().optional(),
  bonus_op: z.string().optional(),
});

export const exchangeIdParamSchema = z.object({
  id: z.string().min(24).max(24),
});

export const exchangeStatementQuerySchema = z.object({
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  playerId: z.string().length(24).optional(),
  entryType: z.enum(["all", "deposit", "withdrawal", "topup"]).default("all"),
});
