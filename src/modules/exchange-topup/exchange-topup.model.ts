import { Schema, model, Types } from "mongoose";

export interface ExchangeTopupDocument {
  _id: Types.ObjectId;
  exchangeId: Types.ObjectId;
  amount: number;
  operatedCurrency?: string;
  operatedAmount?: number;
  exchangeRate?: number;
  remark?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const exchangeTopupSchema = new Schema<ExchangeTopupDocument>(
  {
    exchangeId: { type: Schema.Types.ObjectId, ref: "Exchange", required: true, index: true },
    amount: { type: Number, min: 0.01, required: true },
    operatedCurrency: { type: String, trim: true },
    operatedAmount: { type: Number, min: 0 },
    exchangeRate: { type: Number, min: 0 },
    remark: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true },
);

exchangeTopupSchema.index({ exchangeId: 1, createdAt: -1 });

export const ExchangeTopupModel = model<ExchangeTopupDocument>("ExchangeTopup", exchangeTopupSchema);
