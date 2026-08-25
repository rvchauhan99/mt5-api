import { z } from "zod";
import { moneyFxInputSchema, openingMoneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

const optionalTrimmed = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
  z.string().optional(),
);

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "entryDate must be YYYY-MM-DD");

export const liabilityViewModeSchema = z.enum(["platform", "person"]).optional();

export const liabilityPersonIdParamSchema = z.object({
  id: z.string().length(24),
});

const openingPersonBodyRefine = (data: { openingAmount?: number; openingKind?: "payable" | "receivable" }, ctx: z.RefinementCtx) => {
  if (data.openingKind !== undefined && data.openingAmount === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openingAmount is required when openingKind is set",
      path: ["openingAmount"],
    });
  }
  if (data.openingAmount !== undefined && data.openingAmount > 0 && data.openingKind === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openingKind is required when openingAmount > 0",
      path: ["openingKind"],
    });
  }
};

export const createLiabilityPersonBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    phone: optionalTrimmed,
    email: optionalTrimmed,
    notes: optionalTrimmed,
    isActive: z.boolean().optional(),
    /** Legacy signed value; ignored when openingAmount is present. */
    openingBalance: z.number().optional(),
    openingAmount: z.number().min(0).optional(),
    openingKind: z.enum(["payable", "receivable"]).optional(),
  })
  .merge(openingMoneyFxInputSchema)
  .superRefine(openingPersonBodyRefine);

export const updateLiabilityPersonBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: optionalTrimmed,
    email: optionalTrimmed,
    notes: optionalTrimmed,
    isActive: z.boolean().optional(),
    openingBalance: z.number().optional(),
    openingAmount: z.number().min(0).optional(),
    openingKind: z.enum(["payable", "receivable"]).optional(),
  })
  .merge(openingMoneyFxInputSchema.partial())
  .superRefine(openingPersonBodyRefine);

export const listLiabilityPersonQuerySchema = z.object({
  search: optionalTrimmed,
  isActive: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v)),
    z.enum(["true", "false"]).optional(),
  ),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z.enum(["createdAt", "name", "openingBalance", "isActive"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const createLiabilityEntryBodySchema = z.object({
  entryDate: ymd,
  entryType: z.enum(["receipt", "payment", "contra", "journal"]),
  amount: z.number().min(0.01),
  fromAccountType: z.enum(["bank", "person"]),
  fromAccountId: z.string().length(24),
  toAccountType: z.enum(["bank", "person"]),
  toAccountId: z.string().length(24),
  referenceNo: optionalTrimmed,
  remark: optionalTrimmed,
}).merge(moneyFxInputSchema);

export const listLiabilityEntryQuerySchema = z.object({
  search: optionalTrimmed,
  entryType: z.enum(["receipt", "payment", "contra", "journal"]).optional(),
  accountType: z.enum(["bank", "person"]).optional(),
  accountId: z.string().length(24).optional(),
  entryDate_from: optionalTrimmed,
  entryDate_to: optionalTrimmed,
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z.enum(["createdAt", "entryDate", "amount", "entryType"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const liabilityLedgerQuerySchema = z.object({
  fromDate: optionalTrimmed,
  toDate: optionalTrimmed,
  viewMode: liabilityViewModeSchema,
});

export const liabilityReportQuerySchema = z.object({
  viewMode: liabilityViewModeSchema,
});
