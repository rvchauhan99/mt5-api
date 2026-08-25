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

const settleReferralBaseSchema = z.object({
  accrualIds: z.array(z.string().length(24)).min(1),
  remark: z.string().trim().max(1000).optional(),
});

export const settleReferralAccrualBodySchema = z.intersection(
  settleReferralBaseSchema,
  z.discriminatedUnion("settlementAccountType", [
    z.object({
      settlementAccountType: z.literal("bank"),
      bankId: z.string().length(24),
    }),
    z.object({
      settlementAccountType: z.literal("person"),
      liabilityPersonId: z.string().length(24),
    }),
  ]),
);

export const referralAccrualIdParamSchema = z.object({
  id: z.string().length(24),
});

export const updateReferralAccrualBodySchema = z
  .object({
    referralPercentage: z.number().min(0).max(100).optional(),
    accruedAmount: z.number().min(0).optional(),
  })
  .refine(
    (body) => {
      const hasPct = body.referralPercentage !== undefined;
      const hasAmt = body.accruedAmount !== undefined;
      return (hasPct && !hasAmt) || (!hasPct && hasAmt);
    },
    { message: "Provide exactly one of referralPercentage or accruedAmount" },
  );
