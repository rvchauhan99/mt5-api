import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../../shared/constants/currencies";
import { moneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

const optionalDateTime = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z.string().datetime({ offset: true }).optional(),
);

const depositCoreFieldsSchema = z.object({
  utr: z.string().min(4).max(120).trim(),
  /** Operated-currency amount (converted to platform on save). */
  amount: z.number().positive(),
  entryAt: optionalDateTime,
}).merge(moneyFxInputSchema);

const depositSettlementFieldsSchema = z.object({
  settlementAccountType: z.enum(["bank", "person"]).optional().default("bank"),
  bankId: z.string().length(24).optional(),
  liabilityPersonId: z.string().length(24).optional(),
});

function refineDepositSettlement(
  data: { settlementAccountType?: "bank" | "person"; bankId?: string; liabilityPersonId?: string },
  ctx: z.RefinementCtx,
) {
  const mode = data.settlementAccountType ?? "bank";
  if (mode === "bank") {
    if (!data.bankId || data.bankId.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Bank is required.", path: ["bankId"] });
    }
  } else if (!data.liabilityPersonId || data.liabilityPersonId.trim() === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Liability person is required.",
      path: ["liabilityPersonId"],
    });
  }
}

/** Single-stage create: settlement + trader/bonus; service settles to verified. */
export const createDepositBodySchema = depositCoreFieldsSchema
  .merge(depositSettlementFieldsSchema)
  .extend({
    playerId: z.string().length(24),
    bonusAmount: z.number().int().min(0),
  })
  .superRefine(refineDepositSettlement);

/** Pending-only banker-style update (legacy pending rows). */
export const updateDepositBodySchema = depositCoreFieldsSchema
  .merge(depositSettlementFieldsSchema)
  .superRefine(refineDepositSettlement);

export const listDepositQuerySchema = z.object({
  view: z.enum(["banker", "exchange", "final"]).default("banker"),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z
    .enum([
      "entryAt",
      "createdAt",
      "amount",
      "utr",
      "status",
      "bonusAmount",
      "totalAmount",
      "settledAt",
      "bankName",
    ])
    .default("entryAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().optional(),
  utr: z.string().optional(),
  utr_op: z.string().optional(),
  bankName: z.string().optional(),
  bankName_op: z.string().optional(),
  bankId: z.string().optional(),
  status: z.string().optional(),
  amount: z.string().optional(),
  amount_to: z.string().optional(),
  amount_op: z.string().optional(),
  totalAmount: z.string().optional(),
  totalAmount_to: z.string().optional(),
  totalAmount_op: z.string().optional(),
  player: z.string().optional(),
  createdBy: z.string().optional(),
  createdAt_from: z.string().optional(),
  createdAt_to: z.string().optional(),
  createdAt_op: z.string().optional(),
  /** Filter: deposits that have at least one amendment (`yes`) or none (`no`). */
  hasAmendment: z.enum(["yes", "no"]).optional(),
});

export const approvalQueueEventsQuerySchema = z.object({
  view: z.enum(["banker", "exchange"]),
});

export const bulkExchangeApproveBodySchema = z.object({
  depositIds: z
    .array(z.string().length(24))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate deposit ids are not allowed" }),
});

export const createBulkExchangeApproveJobBodySchema = bulkExchangeApproveBodySchema;

export const exchangeActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark_not_settled"),
  }),
  z.object({
    action: z.literal("approve"),
    playerId: z.string().length(24),
    bonusAmount: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("reject"),
    reasonId: z.string().length(24),
    remark: z.string().max(2000).trim().optional(),
  }),
]);

/** Post-settlement amendment for verified deposits. `bankId` required for bank-settled rows; omitted for person-settled. */
export const amendDepositBodySchema = z.object({
  bankId: z.string().length(24).optional(),
  utr: z.string().min(4).max(120).trim(),
  amount: z.number().min(0),
  playerId: z.string().length(24),
  bonusAmount: z.number().min(0),
  entryAt: optionalDateTime,
  reasonId: z.string().length(24),
  remark: z.string().max(2000).trim().optional(),
}).merge(moneyFxInputSchema);

const depositImportRowSchema = z.object({
  utr: z.string().min(4).max(120),
  amount: z.number().positive(),
  operatedCurrency: z.enum(SUPPORTED_CURRENCIES),
  operatedAmount: z.number().min(0),
  exchangeRate: z.number().positive(),
  entryAt: z.string().optional(),
  settlementAccountType: z.enum(["bank", "person"]).default("bank"),
  bankId: z.string().length(24).optional(),
  liabilityPersonId: z.string().length(24).optional(),
  playerMongoId: z.string().length(24),
  bonusAmount: z.number().min(0),
  totalAmount: z.number().positive().optional(),
});

export const commitDepositImportBodySchema = z.object({
  rows: z.array(depositImportRowSchema).min(1).max(500),
});

export const createDepositImportJobBodySchema = z.object({
  rows: z.array(depositImportRowSchema).min(1).max(10000),
});
