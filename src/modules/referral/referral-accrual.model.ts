import { Schema, model, Types } from "mongoose";

export type ReferralAccrualStatus = "accrued" | "settled" | "cancelled";

export interface ReferralAccrualDocument {
  _id: Types.ObjectId;
  referrerPlayerId: Types.ObjectId;
  referredPlayerId: Types.ObjectId;
  exchangeId: Types.ObjectId;
  sourceDepositId: Types.ObjectId;
  sourceDepositAmount: number;
  referralPercentage: number;
  accruedAmount: number;
  status: ReferralAccrualStatus;
  cancelledReason?: string;
  settledAt?: Date;
  settledBy?: Types.ObjectId;
  settlementDepositId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const referralAccrualSchema = new Schema<ReferralAccrualDocument>(
  {
    referrerPlayerId: { type: Schema.Types.ObjectId, required: true, ref: "Player", index: true },
    referredPlayerId: { type: Schema.Types.ObjectId, required: true, ref: "Player", index: true },
    exchangeId: { type: Schema.Types.ObjectId, required: true, ref: "Exchange", index: true },
    sourceDepositId: { type: Schema.Types.ObjectId, required: true, ref: "Deposit", unique: true },
    sourceDepositAmount: { type: Number, required: true, min: 0 },
    referralPercentage: { type: Number, required: true, min: 0, max: 100, default: 1 },
    accruedAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["accrued", "settled", "cancelled"], default: "accrued", index: true },
    cancelledReason: { type: String, trim: true },
    settledAt: { type: Date },
    settledBy: { type: Schema.Types.ObjectId, ref: "User" },
    settlementDepositId: { type: Schema.Types.ObjectId, ref: "Deposit" },
  },
  { timestamps: true },
);

referralAccrualSchema.index({ referrerPlayerId: 1, status: 1, createdAt: -1 });
referralAccrualSchema.index({ exchangeId: 1, status: 1, createdAt: -1 });

export const ReferralAccrualModel = model<ReferralAccrualDocument>("ReferralAccrual", referralAccrualSchema);
