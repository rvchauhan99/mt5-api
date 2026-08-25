import { z } from "zod";

export const listReferralAccrualQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  cursor: z.string().optional(),
  status: z.enum(["accrued", "settled", "cancelled"]).optional(),
  referrerPlayerId: z.string().length(24).optional(),
  referredPlayerId: z.string().length(24).optional(),
  exchangeId: z.string().length(24).optional(),
});

export const settleReferralAccrualBodySchema = z.object({
  accrualIds: z.array(z.string().length(24)).min(1),
  remark: z.string().trim().max(1000).optional(),
});
