/** Values stored on Reason documents (`reasonType`) for rejection flows. */
export const REASON_TYPES = {
  DEPOSIT_EXCHANGE_REJECT: "deposit_exchange_reject",
  WITHDRAWAL_BANKER_REJECT: "withdrawal_banker_reject",
  EXPENSE_AUDIT_REJECT: "expense_audit_reject",
  EXPENSE_CANCEL: "expense_cancel",
  DEPOSIT_FINAL_AMEND: "deposit_final_amend",
  WITHDRAWAL_FINAL_AMEND: "withdrawal_final_amend",
} as const;

export type ReasonType = (typeof REASON_TYPES)[keyof typeof REASON_TYPES];
