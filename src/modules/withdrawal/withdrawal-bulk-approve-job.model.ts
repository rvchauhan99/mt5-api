import { Schema, model, type Types } from "mongoose";

export type WithdrawalBulkApproveJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface WithdrawalBulkApproveJobErrorItem {
  withdrawalId: string;
  error: string;
}

export interface WithdrawalBulkApproveJobProgress {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
}

export interface WithdrawalBulkApproveJobDocument {
  _id: Types.ObjectId;
  status: WithdrawalBulkApproveJobStatus;
  createdBy: Types.ObjectId;
  withdrawalIds: string[];
  startedAt?: Date;
  finishedAt?: Date;
  failureReason?: string;
  progress: WithdrawalBulkApproveJobProgress;
  errorSample: WithdrawalBulkApproveJobErrorItem[];
  errorRows: WithdrawalBulkApproveJobErrorItem[];
  lock?: {
    lockedBy: string;
    lockedAt: Date;
    heartbeatAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const progressSchema = new Schema<WithdrawalBulkApproveJobProgress>(
  {
    totalRows: { type: Number, default: 0, min: 0 },
    processedRows: { type: Number, default: 0, min: 0 },
    successRows: { type: Number, default: 0, min: 0 },
    failedRows: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const errorItemSchema = new Schema<WithdrawalBulkApproveJobErrorItem>(
  {
    withdrawalId: { type: String, required: true, trim: true },
    error: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const lockSchema = new Schema(
  {
    lockedBy: { type: String, required: true },
    lockedAt: { type: Date, required: true },
    heartbeatAt: { type: Date, required: true },
  },
  { _id: false },
);

const withdrawalBulkApproveJobSchema = new Schema<WithdrawalBulkApproveJobDocument>(
  {
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "cancelled"],
      required: true,
      default: "queued",
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
    withdrawalIds: { type: [String], required: true, default: [] },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    failureReason: { type: String },
    progress: { type: progressSchema, default: () => ({}) },
    errorSample: { type: [errorItemSchema], default: [] },
    errorRows: { type: [errorItemSchema], default: [] },
    lock: { type: lockSchema, required: false },
  },
  { timestamps: true },
);

withdrawalBulkApproveJobSchema.index({ status: 1, createdAt: 1 });
withdrawalBulkApproveJobSchema.index({ "lock.heartbeatAt": 1 });

export const WithdrawalBulkApproveJobModel = model<WithdrawalBulkApproveJobDocument>(
  "WithdrawalBulkApproveJob",
  withdrawalBulkApproveJobSchema,
);
