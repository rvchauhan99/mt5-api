export const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",

  SUB_ADMIN_ADD: "sub_admin.add",
  SUB_ADMIN_LIST: "sub_admin.list",
  SUB_ADMIN_EDIT: "sub_admin.edit",

  EXCHANGE_ADD: "exchange.add",
  EXCHANGE_LIST: "exchange.list",
  EXCHANGE_STATEMENT: "exchange.statement",
  EXCHANGE_TOPUP_ADD: "exchange.topup_add",
  EXCHANGE_TOPUP_LIST: "exchange.topup_list",

  PLAYER_ADD: "player.add",
  PLAYER_LIST: "player.list",
  PLAYER_EDIT: "player.edit",

  BANK_ADD: "bank.add",
  BANK_LIST: "bank.list",
  BANK_STATEMENT: "bank.statement",

  DEPOSIT_BANKER: "deposit.banker",
  DEPOSIT_EXCHANGE: "deposit.exchange",
  DEPOSIT_FINAL_VIEW: "deposit.final_view",

  WITHDRAWAL_EXCHANGE: "withdrawal.exchange",
  WITHDRAWAL_BANKER: "withdrawal.banker",
  WITHDRAWAL_FINAL_VIEW: "withdrawal.final_view",

  REPORTS_TRANSACTION_HISTORY: "reports.transaction_history",
  REPORTS_EXPENSE_ANALYSIS: "reports.expense_analysis",
  USER_HISTORY_VIEW: "user_history.view",

  EXPENSE_ADD: "expense.add",
  EXPENSE_LIST: "expense.list",
  EXPENSE_AUDIT: "expense.audit",

  LIABILITY_PERSON_ADD: "liability.person_add",
  LIABILITY_PERSON_LIST: "liability.person_list",
  LIABILITY_ENTRY_ADD: "liability.entry_add",
  LIABILITY_ENTRY_LIST: "liability.entry_list",
  LIABILITY_LEDGER_VIEW: "liability.ledger_view",
  LIABILITY_REPORT_VIEW: "liability.report_view",

  REFERRAL_LIST: "referral.list",
  REFERRAL_SETTLE: "referral.settle",
} as const;

export const DEFAULT_ADMIN_PERMISSIONS = Object.values(PERMISSIONS);
