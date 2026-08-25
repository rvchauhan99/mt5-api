import { Schema, model, Types } from "mongoose";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "../../shared/constants/currencies";

export interface ExchangeRateDocument {
  _id: Types.ObjectId;
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
  /** 1 fromCurrency = rate toCurrency */
  rate: number;
  isActive: boolean;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const exchangeRateSchema = new Schema<ExchangeRateDocument>(
  {
    fromCurrency: { type: String, enum: SUPPORTED_CURRENCIES, required: true, trim: true },
    toCurrency: { type: String, enum: SUPPORTED_CURRENCIES, required: true, trim: true },
    rate: {
      type: Number,
      required: true,
      min: [Number.MIN_VALUE, "Rate must be greater than zero"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Rate must be greater than zero",
      },
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

exchangeRateSchema.index(
  { fromCurrency: 1, toCurrency: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
  },
);
exchangeRateSchema.index({ deletedAt: 1, isActive: 1 });

export const ExchangeRateModel = model<ExchangeRateDocument>("ExchangeRate", exchangeRateSchema);
