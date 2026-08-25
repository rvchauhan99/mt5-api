import { z } from "zod";
import { moneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

const optionalDateTime = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z.string().datetime({ offset: true }).optional(),
);

export const createWithdrawalBodySchema = z.object({
  playerId: z.string().length(24),
  accountNumber: z.string().min(1).max(40).trim(),
  accountHolderName: z.string().min(1).max(120).trim(),
  bankName: z.string().min(1).max(120).trim(),
  ifsc: z.string().min(4).max(20).trim(),
  amount: z.number().positive(),
  reverseBonus: z.number().min(0).optional().default(0),
  requestedAt: optionalDateTime,
}).merge(moneyFxInputSchema);

export const withdrawalBankerPayoutBodySchema = z
  .object({
    payoutSettlementType: z.enum(["bank", "person"]).optional().default("bank"),
    bankId: z.string().length(24).optional(),
    liabilityPersonId: z.string().length(24).optional(),
    utr: z.string().min(4).max(120).trim(),
  })
  .superRefine((data, ctx) => {
    const mode = data.payoutSettlementType ?? "bank";
    if (mode === "bank") {
      if (!data.bankId?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Payout bank is required.", path: ["bankId"] });
      }
    } else if (!data.liabilityPersonId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Liability person is required.",
        path: ["liabilityPersonId"],
      });
    }
  });

export const updateWithdrawalBodySchema = z.object({
  accountNumber: z.string().min(1).max(40).trim(),
  accountHolderName: z.string().min(1).max(120).trim(),
  bankName: z.string().min(1).max(120).trim(),
  ifsc: z.string().min(4).max(20).trim(),
  amount: z.number().positive(),
  reverseBonus: z.number().min(0).optional().default(0),
}).merge(moneyFxInputSchema);

export const listWithdrawalQuerySchema = z.object({
  view: z.enum(["exchange", "banker", "final"]).default("exchange"),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z
    .enum(["requestedAt", "createdAt", "amount", "payableAmount", "status", "playerName", "bankName", "utr"])
    .default("requestedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().optional(),
  status: z.string().optional(),
  playerName: z.string().optional(),
  playerName_op: z.string().optional(),
  utr: z.string().optional(),
  utr_op: z.string().optional(),
  bankName: z.string().optional(),
  bankName_op: z.string().optional(),
  amount: z.string().optional(),
  amount_to: z.string().optional(),
  amount_op: z.string().optional(),
  payableAmount: z.string().optional(),
  payableAmount_to: z.string().optional(),
  payableAmount_op: z.string().optional(),
  createdAt_from: z.string().optional(),
  createdAt_to: z.string().optional(),
  createdAt_op: z.string().optional(),
  hasAmendment: z.enum(["yes", "no"]).optional(),
});

export const approvalQueueEventsQuerySchema = z.object({
  view: z.enum(["banker", "exchange"]),
});

export const updateWithdrawalStatusBodySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("rejected"),
    reasonId: z.string().length(24),
    remark: z.string().max(2000).trim().optional(),
  }),
  z.object({
    status: z.literal("finalized"),
  }),
]);

export const amendWithdrawalBodySchema = z.object({
  amount: z.number().min(0),
  reverseBonus: z.number().min(0),
  payoutBankId: z.string().length(24).optional(),
  utr: z.string().min(4).max(120).trim(),
  requestedAt: optionalDateTime,
  reasonId: z.string().length(24),
  remark: z.string().max(2000).trim().optional(),
}).merge(moneyFxInputSchema);

const withdrawalImportRowSchema = z.object({
  playerMongoId: z.string().length(24),
  accountNumber: z.string().min(1).max(40),
  accountHolderName: z.string().min(1).max(120),
  bankName: z.string().min(1).max(120),
  ifsc: z.string().min(4).max(20),
  amount: z.number().positive(),
  reverseBonus: z.number().min(0).optional().default(0),
  requestedAt: z.string().optional(),
  payoutUtr: z.string().min(4).max(120).optional(),
  payoutSettlementType: z.enum(["bank", "person"]).optional().default("bank"),
  payoutBankId: z.string().length(24).optional(),
  payoutLiabilityPersonId: z.string().length(24).optional(),
}).merge(moneyFxInputSchema);

export const commitWithdrawalImportBodySchema = z.object({
  rows: z.array(withdrawalImportRowSchema).min(1).max(500),
});

export const createWithdrawalImportJobBodySchema = z.object({
  rows: z.array(withdrawalImportRowSchema).min(1).max(10000),
});

export const bulkBankerApproveBodySchema = z.object({
  withdrawalIds: z
    .array(z.string().length(24))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate withdrawal ids are not allowed" }),
});

export const createBulkBankerApproveJobBodySchema = bulkBankerApproveBodySchema;
