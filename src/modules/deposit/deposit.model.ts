import { Schema, model, Types } from "mongoose";

/** pending = awaiting exchange; not_settled = approved but unclaimed; verified = approved and settled on bank; rejected = exchange rejected; finalized = legacy */
export type DepositStatus = "pending" | "not_settled" | "verified" | "rejected" | "finalized";

/** Snapshot of deposit fields stored on each amendment entry (plain ids for JSON stability). */
export interface DepositAmendmentSnapshot {
  bankId?: string;
  bankName?: string;
  liabilityPersonId?: string;
  liabilityPersonName?: string;
  utr?: string;
  amount?: number;
  playerId?: string;
  bonusAmount?: number;
  totalAmount?: number;
}

export interface DepositAmendmentEntry {
  at: Date;
  by: Types.ObjectId;
  reason: string;
  old: DepositAmendmentSnapshot;
  new: DepositAmendmentSnapshot;
}

/** Cash settlement anchor: bank (default) or liability person intermediary. */
export type DepositSettlementAccountType = "bank" | "person";

export interface DepositDocument {
  _id: Types.ObjectId;
  settlementAccountType?: DepositSettlementAccountType;
  bankId?: Types.ObjectId;
  /** Denormalized display label (legacy rows may only have this). */
  bankName: string;
  liabilityPersonId?: Types.ObjectId;
  liabilityPersonName?: string;
  liabilityEntryId?: Types.ObjectId;
  utr: string;
  amount: number;
  /** FX reference: currency the user entered the amount in */
  operatedCurrency?: string;
  operatedAmount?: number;
  exchangeRate?: number;
  status: DepositStatus;
  createdBy: Types.ObjectId;
  player?: Types.ObjectId;
  bonusAmount?: number;
  totalAmount?: number;
  rejectReason?: string;
  /** Master Reason row for rejection (optional for legacy). */
  rejectReasonId?: Types.ObjectId;
  exchangeActionBy?: Types.ObjectId;
  exchangeActionAt?: Date;
  bankBalanceAfter?: number;
  bankImpact?: boolean;
  isReferralSettlement?: boolean;
  referralSettlementRemark?: string;
  /** Business entry datetime selected by banker (can be backdated). */
  entryAt?: Date;
  settledAt?: Date;
  /** Number of successful post-settlement amendments. */
  amendmentCount?: number;
  lastAmendedAt?: Date;
  lastAmendedBy?: Types.ObjectId;
  amendmentHistory?: DepositAmendmentEntry[];
  /** Composite duplicate fingerprint (trader + settlement + amount + date + reference). */
  duplicateKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const amendmentSnapshotSchema = new Schema<DepositAmendmentSnapshot>(
  {
    bankId: { type: String, trim: true },
    bankName: { type: String, trim: true },
    liabilityPersonId: { type: String, trim: true },
    liabilityPersonName: { type: String, trim: true },
    utr: { type: String, trim: true },
    amount: { type: Number },
    playerId: { type: String, trim: true },
    bonusAmount: { type: Number },
    totalAmount: { type: Number },
  },
  { _id: false },
);

const amendmentEntrySchema = new Schema<DepositAmendmentEntry>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    reason: { type: String, required: true, trim: true },
    old: { type: amendmentSnapshotSchema, required: true },
    new: { type: amendmentSnapshotSchema, required: true },
  },
  { _id: false },
);

const depositSchema = new Schema<DepositDocument>(
  {
    settlementAccountType: { type: String, enum: ["bank", "person"] },
    bankId: { type: Schema.Types.ObjectId, ref: "Bank" },
    bankName: { type: String, trim: true, default: "" },
    liabilityPersonId: { type: Schema.Types.ObjectId, ref: "LiabilityPerson" },
    liabilityPersonName: { type: String, trim: true, default: "" },
    liabilityEntryId: { type: Schema.Types.ObjectId, ref: "LiabilityEntry" },
    utr: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    operatedCurrency: { type: String, trim: true },
    operatedAmount: { type: Number, min: 0 },
    exchangeRate: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ["pending", "not_settled", "verified", "rejected", "finalized"],
      default: "pending",
    },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    player: { type: Schema.Types.ObjectId, ref: "Player" },
    bonusAmount: { type: Number, min: 0 },
    totalAmount: { type: Number, min: 0 },
    rejectReason: { type: String, trim: true },
    rejectReasonId: { type: Schema.Types.ObjectId, ref: "Reason" },
    exchangeActionBy: { type: Schema.Types.ObjectId, ref: "User" },
    exchangeActionAt: { type: Date },
    bankBalanceAfter: { type: Number, min: 0 },
    bankImpact: { type: Boolean, default: true },
    isReferralSettlement: { type: Boolean, default: false },
    referralSettlementRemark: { type: String, trim: true, maxlength: 1000 },
    entryAt: { type: Date },
    settledAt: { type: Date },
    amendmentCount: { type: Number, min: 0, default: 0 },
    lastAmendedAt: { type: Date },
    lastAmendedBy: { type: Schema.Types.ObjectId, ref: "User" },
    amendmentHistory: { type: [amendmentEntrySchema], default: [] },
    duplicateKey: { type: String, trim: true },
  },
  { timestamps: true },
);

/** Composite duplicate fingerprint among non-rejected deposits. */
depositSchema.index(
  { duplicateKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $ne: "rejected" },
      duplicateKey: { $exists: true, $type: "string", $ne: "" },
    },
  },
);
depositSchema.index({ status: 1, entryAt: -1, _id: -1 });
depositSchema.index({ status: 1, createdAt: -1, _id: -1 });
depositSchema.index({ player: 1, createdAt: -1, _id: -1 });
depositSchema.index({ bankId: 1, createdAt: -1, _id: -1 });

export const DepositModel = model<DepositDocument>("Deposit", depositSchema);
