import { z } from "zod";
import { moneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

export const createExchangeTopupBodySchema = z.object({
  exchangeId: z.string().length(24),
  amount: z.number().positive(),
  remark: z.string().trim().max(1000).optional(),
}).merge(moneyFxInputSchema);

export const listExchangeTopupQuerySchema = z.object({
  exchangeId: z.string().length(24).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});
