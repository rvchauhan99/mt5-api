/** Known default codes (also seeded into Payment Method master). */
export const BANK_METHODS = ["crypto", "bank_transfer", "sgpay", "trustpay", "card_entry"] as const;
export type BankMethod = string;

export const BANK_METHOD_LABELS: Record<(typeof BANK_METHODS)[number], string> = {
  crypto: "Crypto",
  bank_transfer: "Bank Transfer",
  sgpay: "SGPay",
  trustpay: "TrustPay",
  card_entry: "Card Entry",
};

export function humanizeMethodCode(code: string): string {
  return code
    .trim()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function bankMethodLabel(method: unknown): string | undefined {
  if (typeof method !== "string" || !method.trim()) return undefined;
  const key = method.trim() as (typeof BANK_METHODS)[number];
  if ((BANK_METHODS as readonly string[]).includes(key)) {
    return BANK_METHOD_LABELS[key];
  }
  return humanizeMethodCode(method);
}

export function toMethodCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export type BankDisplayInput = {
  method?: string | null;
  holderName?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
};

export function bankDisplayName(b: BankDisplayInput): string {
  const methodLabel = bankMethodLabel(b.method);
  const name = String(b.holderName ?? "").trim();
  if (methodLabel) {
    if (name && name.toLowerCase() !== methodLabel.toLowerCase()) {
      return `${name} (${methodLabel})`;
    }
    return name || methodLabel;
  }
  const bankName = String(b.bankName ?? "").trim();
  const account = String(b.accountNumber ?? "").trim();
  const last4 = account.length >= 4 ? account.slice(-4) : account;
  const parts = [name, bankName].filter(Boolean);
  if (last4) parts.push(last4);
  return parts.join(" - ") || "Unknown";
}
