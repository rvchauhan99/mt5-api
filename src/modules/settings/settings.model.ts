import { Schema, model, Types } from "mongoose";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "../../shared/constants/currencies";

export const PLATFORM_SETTINGS_KEY = "platform";

export interface PlatformSettingsDocument {
  _id: Types.ObjectId;
  key: typeof PLATFORM_SETTINGS_KEY;
  platformCurrency?: SupportedCurrency;
  currencyLockedAt?: Date;
  currencyLockedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const platformSettingsSchema = new Schema<PlatformSettingsDocument>(
  {
    key: { type: String, required: true, unique: true, default: PLATFORM_SETTINGS_KEY },
    platformCurrency: { type: String, enum: SUPPORTED_CURRENCIES },
    currencyLockedAt: { type: Date },
    currencyLockedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export const PlatformSettingsModel = model<PlatformSettingsDocument>(
  "PlatformSettings",
  platformSettingsSchema,
);
