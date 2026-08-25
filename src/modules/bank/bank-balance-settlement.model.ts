import { Schema, model, Types } from "mongoose";

export interface BankBalanceSettlementDocument {
  _id: Types.ObjectId;
  bankId: Types.ObjectId;
  effectiveAt: Date;
  masterReportedBalance: number;
  signedAmount: number;
  systemBalanceBefore: number;
  reason: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const bankBalanceSettlementSchema = new Schema<BankBalanceSettlementDocument>(
  {
    bankId: { type: Schema.Types.ObjectId, required: true, ref: "Bank", index: true },
    effectiveAt: { type: Date, required: true, index: true },
    masterReportedBalance: { type: Number, required: true },
    signedAmount: { type: Number, required: true },
    systemBalanceBefore: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 4000 },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true },
);

bankBalanceSettlementSchema.index({ bankId: 1, effectiveAt: -1 });

export const BankBalanceSettlementModel = model<BankBalanceSettlementDocument>(
  "BankBalanceSettlement",
  bankBalanceSettlementSchema,
);
