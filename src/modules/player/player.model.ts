import { Schema, model, Types } from "mongoose";

export interface PlayerDocument {
  _id: Types.ObjectId;
  exchange: Types.ObjectId;
  playerId: string;
  phone: string;
  isMigratedOldUser: boolean;
  regularBonusPercentage: number;
  firstDepositBonusPercentage: number;
  referredByPlayerId?: Types.ObjectId;
  referralPercentage: number;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const playerSchema = new Schema<PlayerDocument>(
  {
    exchange: { type: Schema.Types.ObjectId, required: true, ref: "Exchange" },
    playerId: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    isMigratedOldUser: { type: Boolean, required: true, default: false, index: true },
    regularBonusPercentage: { type: Number, required: true, min: 0, max: 100, default: 0 },
    firstDepositBonusPercentage: { type: Number, required: true, min: 0, max: 100, default: 0 },
    referredByPlayerId: { type: Schema.Types.ObjectId, ref: "Player" },
    referralPercentage: { type: Number, required: true, min: 0, max: 100, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true },
);

playerSchema.index({ exchange: 1, playerId: 1 }, { unique: true });
playerSchema.index({ createdAt: -1, _id: -1 });
playerSchema.index({ createdBy: 1, createdAt: -1, _id: -1 });
playerSchema.index({ phone: 1 });

export const PlayerModel = model<PlayerDocument>("Player", playerSchema);
