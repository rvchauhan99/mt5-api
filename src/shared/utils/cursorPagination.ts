export type TimeCursor = {
  t: string;
  id: string;
};

export function encodeTimeCursor(input: { t: Date | string; id: string }): string {
  const payload: TimeCursor = {
    t: input.t instanceof Date ? input.t.toISOString() : String(input.t),
    id: String(input.id),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeTimeCursor(raw: string | undefined): TimeCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(String(raw), "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<TimeCursor>;
    if (!parsed.t || !parsed.id) return null;
    return { t: String(parsed.t), id: String(parsed.id) };
  } catch {
    return null;
  }
}
