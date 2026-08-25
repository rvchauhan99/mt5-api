import { Schema, model, Types } from "mongoose";

/** requested = awaiting banker payout UTR; approved = banker completed; rejected; finalized = closed */
export type WithdrawalStatus = "requested" | "approved" | "rejected" | "finalized";

export type WithdrawalPayoutSettlementType = "bank" | "person";

export interface WithdrawalAmendmentSnapshot {
  amount?: number;
  reverseBonus?: number;
  payableAmount?: number;
  payoutBankId?: string;
  payoutBankName?: string;
  payoutLiabilityPersonId?: string;
  payoutLiabilityPersonName?: string;
  utr?: string;
}

export interface WithdrawalAmendmentEntry {
  at: Date;
  by: Types.ObjectId;
  reason: string;
  old: WithdrawalAmendmentSnapshot;
  new: WithdrawalAmendmentSnapshot;
}

export interface WithdrawalDocument {
  _id: Types.ObjectId;
  /** Set on new rows; legacy rows may omit until backfill */
  player?: Types.ObjectId;
  /** Denormalized for list/export */
  playerName: string;
  /** Beneficiary account (where withdrawal is paid). */
  accountNumber?: string;
  accountHolderName?: string;
  bankName: string;
  ifsc?: string;
  /** Exchange withdrawal amount (platform currency) */
  amount: number;
  operatedCurrency?: string;
  operatedAmount?: number;
  exchangeRate?: number;
  reverseBonus?: number;
  /** amount - reverseBonus (stored for audit) */
  payableAmount?: number;
  /** Bank (default) vs liability person intermediary payout */
  payoutSettlementType?: WithdrawalPayoutSettlementType;
  payoutLiabilityPersonId?: Types.ObjectId;
  payoutLiabilityPersonName?: string;
  payoutLiabilityEntryId?: Types.ObjectId;
  /** Company bank used for payout (set by banker) */
  payoutBankId?: Types.ObjectId;
  payoutBankName?: string;
  utr?: string;
  /** Business requested datetime selected by exchange user (can be backdated). */
  requestedAt?: Date;
  /** Denormalized text from Reason master (+ optional remark). */
  rejectReason?: string;
  rejectReasonId?: Types.ObjectId;
  status: WithdrawalStatus;
  /** @deprecated Legacy queue field; list uses `view` query instead */
  stage?: "exchange" | "banker" | "final";
  createdBy: Types.ObjectId;
  amendmentCount?: number;
  lastAmendedAt?: Date;
  lastAmendedBy?: Types.ObjectId;
  amendmentHistory?: WithdrawalAmendmentEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const withdrawalAmendmentSnapshotSchema = new Schema<WithdrawalAmendmentSnapshot>(
  {
    amount: { type: Number },
    reverseBonus: { type: Number },
    payableAmount: { type: Number },
    payoutBankId: { type: String, trim: true },
    payoutBankName: { type: String, trim: true },
    payoutLiabilityPersonId: { type: String, trim: true },
    payoutLiabilityPersonName: { type: String, trim: true },
    utr: { type: String, trim: true },
  },
  { _id: false },
);

const withdrawalAmendmentEntrySchema = new Schema<WithdrawalAmendmentEntry>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    reason: { type: String, required: true, trim: true },
    old: { type: withdrawalAmendmentSnapshotSchema, required: true },
    new: { type: withdrawalAmendmentSnapshotSchema, required: true },
  },
  { _id: false },
);

const withdrawalSchema = new Schema<WithdrawalDocument>(
  {
    payoutSettlementType: { type: String, enum: ["bank", "person"] },
    payoutLiabilityPersonId: { type: Schema.Types.ObjectId, ref: "LiabilityPerson" },
    payoutLiabilityPersonName: { type: String, trim: true, default: "" },
    payoutLiabilityEntryId: { type: Schema.Types.ObjectId, ref: "LiabilityEntry" },
    player: { type: Schema.Types.ObjectId, ref: "Player" },
    playerName: { type: String, required: true, trim: true },
    accountNumber: { type: String, trim: true, default: "" },
    accountHolderName: { type: String, trim: true, default: "" },
    bankName: { type: String, required: true, trim: true },
    ifsc: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true, min: 0 },
    operatedCurrency: { type: String, trim: true },
    operatedAmount: { type: Number, min: 0 },
    exchangeRate: { type: Number, min: 0 },
    reverseBonus: { type: Number, min: 0, default: 0 },
    payableAmount: { type: Number, min: 0 },
    payoutBankId: { type: Schema.Types.ObjectId, ref: "Bank" },
    payoutBankName: { type: String, trim: true, default: "" },
    utr: { type: String, trim: true },
    requestedAt: { type: Date },
    rejectReason: { type: String, trim: true },
    rejectReasonId: { type: Schema.Types.ObjectId, ref: "Reason" },
    status: {
      type: String,
      enum: ["requested", "approved", "rejected", "finalized"],
      default: "requested",
    },
    stage: { type: String, enum: ["exchange", "banker", "final"] },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    amendmentCount: { type: Number, min: 0, default: 0 },
    lastAmendedAt: { type: Date },
    lastAmendedBy: { type: Schema.Types.ObjectId, ref: "User" },
    amendmentHistory: { type: [withdrawalAmendmentEntrySchema], default: [] },
  },
  { timestamps: true },
);

withdrawalSchema.index({ status: 1, requestedAt: -1, _id: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1, _id: -1 });
withdrawalSchema.index({ player: 1, updatedAt: -1, _id: -1 });
withdrawalSchema.index({ payoutBankId: 1, createdAt: -1, _id: -1 });
withdrawalSchema.index(
  { utr: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $ne: "rejected" },
      utr: { $exists: true, $type: "string", $ne: "" },
    },
  },
);

export const WithdrawalModel = model<WithdrawalDocument>("Withdrawal", withdrawalSchema);
