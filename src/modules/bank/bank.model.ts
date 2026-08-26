import { Schema, model, Types } from "mongoose";
import { BANK_METHODS, type BankMethod } from "./bank.constants";

export interface BankDocument {
  _id: Types.ObjectId;
  method?: BankMethod;
  holderName: string;
  bankName: string;
  accountNumber: string;
  ifsc: string;
  openingBalance: number;
  openingOperatedCurrency?: string;
  openingOperatedAmount?: number;
  openingExchangeRate?: number;
  /** Running balance; if unset, treat as openingBalance (legacy rows). */
  currentBalance?: number;
  status: "active" | "deactive";
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const bankSchema = new Schema<BankDocument>(
  {
    method: { type: String, enum: BANK_METHODS, trim: true },
    holderName: { type: String, required: true, trim: true },
    bankName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true, unique: true },
    ifsc: { type: String, required: true, trim: true },
    openingBalance: { type: Number, required: true, min: 0, default: 0 },
    openingOperatedCurrency: { type: String, trim: true },
    openingOperatedAmount: { type: Number, min: 0 },
    openingExchangeRate: { type: Number, min: 0 },
    currentBalance: { type: Number, min: 0 },
    status: { type: String, enum: ["active", "deactive"], default: "active" },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true },
);

export const BankModel = model<BankDocument>("Bank", bankSchema);
