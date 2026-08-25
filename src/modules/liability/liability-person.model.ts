import { Schema, model, Types } from "mongoose";

export interface LiabilityPersonDocument {
  _id: Types.ObjectId;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  isActive: boolean;
  /** Positive = receivable, Negative = payable (platform currency) */
  openingBalance: number;
  openingOperatedCurrency?: string;
  openingOperatedAmount?: number;
  openingExchangeRate?: number;
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const liabilityPersonSchema = new Schema<LiabilityPersonDocument>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    openingBalance: { type: Number, default: 0 },
    openingOperatedCurrency: { type: String, trim: true },
    openingOperatedAmount: { type: Number, min: 0 },
    openingExchangeRate: { type: Number, min: 0 },
    totalDebits: { type: Number, default: 0, min: 0 },
    totalCredits: { type: Number, default: 0, min: 0 },
    closingBalance: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

liabilityPersonSchema.index({ name: 1 });
liabilityPersonSchema.index({ isActive: 1, createdAt: -1 });

export const LiabilityPersonModel = model<LiabilityPersonDocument>(
  "LiabilityPerson",
  liabilityPersonSchema,
);
