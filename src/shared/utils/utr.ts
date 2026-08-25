export function normalizeUtr(utr: string): string {
  return String(utr).trim().toUpperCase();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
