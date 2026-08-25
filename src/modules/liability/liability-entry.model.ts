import { Schema, model, Types } from "mongoose";

export type LiabilityAccountType = "bank" | "person" | "expense" | "deposit" | "withdrawal";
export type LiabilityEntryType = "receipt" | "payment" | "contra" | "journal";
export type LiabilityEntrySourceType = "expense" | "deposit" | "withdrawal";

export interface LiabilityEntryDocument {
  _id: Types.ObjectId;
  entryDate: Date;
  entryType: LiabilityEntryType;
  amount: number;
  operatedCurrency?: string;
  operatedAmount?: number;
  exchangeRate?: number;
  fromAccountType: LiabilityAccountType;
  fromAccountId: Types.ObjectId;
  toAccountType: LiabilityAccountType;
  toAccountId: Types.ObjectId;
  sourceType?: LiabilityEntrySourceType;
  sourceExpenseId?: Types.ObjectId;
  sourceDepositId?: Types.ObjectId;
  sourceWithdrawalId?: Types.ObjectId;
  referenceNo?: string;
  remark?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const liabilityEntrySchema = new Schema<LiabilityEntryDocument>(
  {
    entryDate: { type: Date, required: true },
    entryType: {
      type: String,
      enum: ["receipt", "payment", "contra", "journal"],
      required: true,
      default: "journal",
    },
    amount: { type: Number, required: true, min: 0.01 },
    operatedCurrency: { type: String, trim: true },
    operatedAmount: { type: Number, min: 0 },
    exchangeRate: { type: Number, min: 0 },
    fromAccountType: { type: String, enum: ["bank", "person", "expense", "deposit", "withdrawal"], required: true },
    fromAccountId: { type: Schema.Types.ObjectId, required: true },
    toAccountType: { type: String, enum: ["bank", "person", "expense", "deposit", "withdrawal"], required: true },
    toAccountId: { type: Schema.Types.ObjectId, required: true },
    sourceType: { type: String, enum: ["expense", "deposit", "withdrawal"] },
    sourceExpenseId: { type: Schema.Types.ObjectId, ref: "Expense" },
    sourceDepositId: { type: Schema.Types.ObjectId, ref: "Deposit" },
    sourceWithdrawalId: { type: Schema.Types.ObjectId, ref: "Withdrawal" },
    referenceNo: { type: String, trim: true, default: "" },
    remark: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

liabilityEntrySchema.index({ entryDate: -1, createdAt: -1 });
liabilityEntrySchema.index({ fromAccountType: 1, fromAccountId: 1, entryDate: -1 });
liabilityEntrySchema.index({ toAccountType: 1, toAccountId: 1, entryDate: -1 });
liabilityEntrySchema.index({ entryType: 1, createdAt: -1 });

export const LiabilityEntryModel = model<LiabilityEntryDocument>("LiabilityEntry", liabilityEntrySchema);
