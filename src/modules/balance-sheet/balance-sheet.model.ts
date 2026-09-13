import { Schema, model, Types } from "mongoose";

export type BalanceSheetSide = "asset" | "liability";
export type BalanceSheetLedgerSourceType =
  | "bank"
  | "exchange"
  | "person"
  | "player"
  | "expense"
  | "referral"
  | "withdrawal"
  | "deposit"
  | "manual"
  | "computed";

/** Stable codes used by seed + calculation engine. */
export const BALANCE_SHEET_GROUP_CODES = {
  FIXED_ASSETS: "fixed_assets",
  CURRENT_ASSETS: "current_assets",
  BANK_ACCOUNTS: "bank_accounts",
  CASH_IN_HAND: "cash_in_hand",
  RECEIVABLES: "receivables",
  EXCHANGE_FLOAT: "exchange_float",
  CAPITAL_RESERVES: "capital_reserves",
  EXCHANGE_CAPITAL: "exchange_capital",
  RETAINED_EARNINGS: "retained_earnings",
  CURRENT_LIABILITIES: "current_liabilities",
  BANK_OVERDRAFTS: "bank_overdrafts",
  PAYABLES: "payables",
  PENDING_WITHDRAWALS: "pending_withdrawals",
  EXPENSES_PAYABLE: "expenses_payable",
  IB_COMMISSIONS: "ib_commissions",
} as const;

export type BalanceSheetGroupCode =
  (typeof BALANCE_SHEET_GROUP_CODES)[keyof typeof BALANCE_SHEET_GROUP_CODES];

export interface BalanceSheetGroupDocument {
  _id: Types.ObjectId;
  code: string;
  name: string;
  parentGroupId: Types.ObjectId | null;
  parentCode: string | null;
  side: BalanceSheetSide;
  level: number;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const balanceSheetGroupSchema = new Schema<BalanceSheetGroupDocument>(
  {
    code: { type: String, required: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    parentGroupId: { type: Schema.Types.ObjectId, ref: "BalanceSheetGroup", default: null },
    parentCode: { type: String, trim: true, default: null },
    side: { type: String, enum: ["asset", "liability"], required: true },
    level: { type: Number, required: true, min: 0, default: 0 },
    sortOrder: { type: Number, required: true, default: 0 },
    isSystem: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

balanceSheetGroupSchema.index({ parentGroupId: 1, sortOrder: 1 });
balanceSheetGroupSchema.index({ side: 1, level: 1, sortOrder: 1 });
balanceSheetGroupSchema.index({ isActive: 1, side: 1 });

export const BalanceSheetGroupModel = model<BalanceSheetGroupDocument>(
  "BalanceSheetGroup",
  balanceSheetGroupSchema,
);

export interface BalanceSheetConfigDocument {
  _id: Types.ObjectId;
  entityType: BalanceSheetLedgerSourceType;
  entityId: Types.ObjectId | null;
  groupCode: string;
  groupId: Types.ObjectId;
  labelOverride?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const balanceSheetConfigSchema = new Schema<BalanceSheetConfigDocument>(
  {
    entityType: {
      type: String,
      enum: [
        "bank",
        "exchange",
        "person",
        "player",
        "expense",
        "referral",
        "withdrawal",
        "deposit",
        "manual",
        "computed",
      ],
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, default: null },
    groupCode: { type: String, required: true, trim: true },
    groupId: { type: Schema.Types.ObjectId, ref: "BalanceSheetGroup", required: true },
    labelOverride: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

balanceSheetConfigSchema.index({ entityType: 1, entityId: 1 }, { unique: true });
balanceSheetConfigSchema.index({ groupCode: 1, isActive: 1 });

export const BalanceSheetConfigModel = model<BalanceSheetConfigDocument>(
  "BalanceSheetConfig",
  balanceSheetConfigSchema,
);

export interface BalanceSheetSnapshotDocument {
  _id: Types.ObjectId;
  asOfDate: Date;
  fromDate: Date;
  toDate: Date;
  exchangeId?: Types.ObjectId | null;
  timeZone: string;
  payload: Record<string, unknown>;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  isBalanced: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const balanceSheetSnapshotSchema = new Schema<BalanceSheetSnapshotDocument>(
  {
    asOfDate: { type: Date, required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    exchangeId: { type: Schema.Types.ObjectId, ref: "Exchange", default: null },
    timeZone: { type: String, required: true, trim: true },
    payload: { type: Schema.Types.Mixed, required: true },
    totalAssets: { type: Number, required: true, default: 0 },
    totalLiabilities: { type: Number, required: true, default: 0 },
    totalEquity: { type: Number, required: true, default: 0 },
    isBalanced: { type: Boolean, required: true, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

balanceSheetSnapshotSchema.index({ exchangeId: 1, asOfDate: -1 });
balanceSheetSnapshotSchema.index({ asOfDate: -1, createdAt: -1 });

export const BalanceSheetSnapshotModel = model<BalanceSheetSnapshotDocument>(
  "BalanceSheetSnapshot",
  balanceSheetSnapshotSchema,
);
