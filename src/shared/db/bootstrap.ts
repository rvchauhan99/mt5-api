import bcrypt from "bcrypt";
import { Types } from "mongoose";
import { ReasonModel } from "../../modules/masters/reason.model";
import { PaymentMethodModel } from "../../modules/masters/payment-method.model";
import { PermissionModel } from "../../modules/permissions/permission.model";
import { UserModel } from "../../modules/users/user.model";
import { PERMISSIONS } from "../constants/permissions";
import { REASON_TYPES } from "../constants/reasonTypes";
import { BANK_METHOD_LABELS, BANK_METHODS } from "../../modules/bank/bank.constants";

export async function bootstrapData() {
  const entries = Object.values(PERMISSIONS).map((key) => {
    const [module, action] = key.split(".");
    return {
      module,
      action,
      key,
      description: `${module} ${action}`.replace(/_/g, " "),
    };
  });
  for (const item of entries) {
    await PermissionModel.updateOne({ key: item.key }, item, { upsert: true });
  }

  const obsoletePermissionKeys = [
    "exchange.edit",
    "bank.edit",
    "deposit.banker_edit",
    "deposit.banker_list",
    "deposit.final_edit",
    "withdrawal.exchange_edit",
    "withdrawal.exchange_list",
    "withdrawal.banker_list",
    "withdrawal.final_edit",
    "expense.master_list",
    "expense.edit",
  ] as const;
  await PermissionModel.deleteMany({ key: { $in: obsoletePermissionKeys } });

  const superadmin = await UserModel.findOne({ role: "superadmin" });
  if (!superadmin) {
    const passwordHash = await bcrypt.hash("SuperAdmin@123", 10);
    await UserModel.create({
      fullName: "Super Admin",
      email: "superadmin@crickierp.local",
      username: "superadmin",
      passwordHash,
      role: "superadmin",
      status: "active",
      permissions: Object.values(PERMISSIONS), // Grant all known permissions to superadmin
    });
  } else {
    superadmin.permissions = Object.values(PERMISSIONS);
    await superadmin.save();
  }

  const actor = (await UserModel.findOne({ role: "superadmin" }).select("_id").lean().exec())?._id;
  if (!actor) return;

  const actorId = actor instanceof Types.ObjectId ? actor : new Types.ObjectId(String(actor));

  const seedRows: { reasonType: string; reason: string; description?: string }[] = [
    // deposit_exchange_reject
    {
      reasonType: REASON_TYPES.DEPOSIT_EXCHANGE_REJECT,
      reason: "UTR / amount mismatch with bank statement",
      description: "Deposit does not match recorded bank credit",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_EXCHANGE_REJECT,
      reason: "Duplicate UTR or duplicate deposit",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_EXCHANGE_REJECT,
      reason: "Wrong bank account or invalid UTR format",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_EXCHANGE_REJECT,
      reason: "Policy / compliance — cannot approve",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_EXCHANGE_REJECT,
      reason: "Other (add details in remark)",
    },
    // withdrawal_banker_reject
    {
      reasonType: REASON_TYPES.WITHDRAWAL_BANKER_REJECT,
      reason: "Insufficient balance or limit issue",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_BANKER_REJECT,
      reason: "Beneficiary bank / IFSC details invalid",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_BANKER_REJECT,
      reason: "Player / KYC or account verification pending",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_BANKER_REJECT,
      reason: "Policy / risk — payout blocked",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_BANKER_REJECT,
      reason: "Other (add details in remark)",
    },
    // expense_audit_reject
    {
      reasonType: REASON_TYPES.EXPENSE_AUDIT_REJECT,
      reason: "Missing or incorrect supporting documents",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_AUDIT_REJECT,
      reason: "Amount or expense type does not match policy",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_AUDIT_REJECT,
      reason: "Wrong bank or payment details",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_AUDIT_REJECT,
      reason: "Duplicate or already booked expense",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_AUDIT_REJECT,
      reason: "Other (add details in remark)",
    },
    // expense_cancel
    {
      reasonType: REASON_TYPES.EXPENSE_CANCEL,
      reason: "Approved in error",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_CANCEL,
      reason: "Duplicate booking",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_CANCEL,
      reason: "Wrong settlement account",
    },
    {
      reasonType: REASON_TYPES.EXPENSE_CANCEL,
      reason: "Other (add details in remark)",
    },
    // deposit_final_amend
    {
      reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
      reason: "Amount correction after reconciliation",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
      reason: "Bonus correction per policy",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
      reason: "Player mapping correction",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
      reason: "Bank / UTR correction",
    },
    {
      reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
      reason: "Other (add details in remark)",
    },
    // withdrawal_final_amend
    {
      reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
      reason: "Amount correction after reconciliation",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
      reason: "Reverse bonus correction",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
      reason: "Payout bank correction",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
      reason: "UTR correction",
    },
    {
      reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
      reason: "Other (add details in remark)",
    },
  ];

  for (const row of seedRows) {
    await ReasonModel.updateOne(
      { reasonType: row.reasonType, reason: row.reason },
      {
        $set: {
          description: row.description ?? "",
          isActive: true,
          deletedAt: null,
          updatedBy: actorId,
        },
        $setOnInsert: {
          reasonType: row.reasonType,
          reason: row.reason,
          createdBy: actorId,
        },
      },
      { upsert: true },
    );
  }

  for (const code of BANK_METHODS) {
    const name = BANK_METHOD_LABELS[code];
    const isRestrictedPayoutMethod = code === "card_entry" || code === "sgpay" || code === "trustpay";
    await PaymentMethodModel.updateOne(
      { code },
      {
        $set: {
          isActive: true,
          deletedAt: null,
          updatedBy: actorId,
          name,
        },
        $setOnInsert: {
          code,
          createdBy: actorId,
          // Defaults only on first insert — do not overwrite admin toggles on restart.
          isActiveForWithdrawalPayout: !isRestrictedPayoutMethod,
          isActiveForDeposit: !isRestrictedPayoutMethod,
        },
      },
      { upsert: true },
    );
  }

  // One-time backfill for existing payment methods missing the new flags.
  await PaymentMethodModel.updateMany(
    {
      isActiveForWithdrawalPayout: { $exists: false },
      code: { $in: ["card_entry", "sgpay", "trustpay"] },
    },
    { $set: { isActiveForWithdrawalPayout: false } },
  );
  await PaymentMethodModel.updateMany(
    { isActiveForWithdrawalPayout: { $exists: false } },
    { $set: { isActiveForWithdrawalPayout: true } },
  );
  await PaymentMethodModel.updateMany(
    {
      isActiveForDeposit: { $exists: false },
      code: { $in: ["card_entry", "sgpay", "trustpay"] },
    },
    { $set: { isActiveForDeposit: false } },
  );
  await PaymentMethodModel.updateMany(
    { isActiveForDeposit: { $exists: false } },
    { $set: { isActiveForDeposit: true } },
  );
}
