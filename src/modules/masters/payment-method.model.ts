import { Schema, model, models, Types } from "mongoose";

export interface PaymentMethodDocument {
  _id: Types.ObjectId;
  name: string;
  code?: string;
  description?: string;
  isActive: boolean;
  isActiveForWithdrawalPayout: boolean;
  isActiveForDeposit: boolean;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const paymentMethodSchema = new Schema<PaymentMethodDocument>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, sparse: true, unique: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    isActiveForWithdrawalPayout: { type: Boolean, default: true },
    isActiveForDeposit: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

paymentMethodSchema.index({ name: 1 });
paymentMethodSchema.index({ deletedAt: 1 });
paymentMethodSchema.index({ name: "text", code: "text", description: "text" });

// Re-register on hot reload so new paths (activation flags) are always present.
if (models.PaymentMethod) {
  delete models.PaymentMethod;
}
export const PaymentMethodModel = model<PaymentMethodDocument>("PaymentMethod", paymentMethodSchema);
