import { z } from "zod";
import { moneyFxInputSchema } from "../../shared/validation/moneyFx.validation";

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expenseDate must be YYYY-MM-DD");

export const createExpenseBodySchema = z.object({
  expenseTypeId: z.string().length(24),
  amount: z.number().min(0.01),
  expenseDate: ymd,
  description: z.string().trim().max(5000).optional(),
  bankId: z.string().length(24).optional(),
  liabilityPersonId: z.string().length(24).optional(),
}).merge(moneyFxInputSchema);

export const updateExpenseBodySchema = z.object({
  expenseTypeId: z.string().length(24).optional(),
  amount: z.number().min(0.01).optional(),
  expenseDate: ymd.optional(),
  description: z.string().trim().max(5000).optional(),
  bankId: z.union([z.string().length(24), z.literal(""), z.null()]).optional(),
}).merge(moneyFxInputSchema.partial());

export const listExpenseQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z
    .enum(["createdAt", "expenseDate", "amount", "status", "bankName"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(["pending_audit", "approved", "rejected", "cancelled"]).optional(),
  expenseTypeId: z.string().length(24).optional(),
  bankId: z.string().length(24).optional(),
  expenseDate_from: z.string().optional(),
  expenseDate_to: z.string().optional(),
  expenseDate_op: z.string().optional(),
});

export const approveExpenseBodySchema = z.discriminatedUnion("settlementAccountType", [
  z.object({
    settlementAccountType: z.literal("bank"),
    bankId: z.string().length(24),
  }),
  z.object({
    settlementAccountType: z.literal("person"),
    liabilityPersonId: z.string().length(24),
  }),
]);

export const rejectExpenseBodySchema = z.object({
  reasonId: z.string().length(24),
  remark: z.string().max(2000).trim().optional(),
});

export const cancelExpenseBodySchema = z.object({
  reasonId: z.string().length(24),
  remark: z.string().max(2000).trim().optional(),
});

export const expenseIdParamSchema = z.object({
  id: z.string().length(24),
});

export const expenseDocumentViewParamsSchema = z.object({
  id: z.string().length(24),
  docIndex: z.coerce.number().int().nonnegative(),
});
