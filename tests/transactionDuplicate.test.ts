import { Types } from "mongoose";
import {
  buildTransactionDayRange,
  buildTransactionDuplicateKey,
} from "../src/shared/utils/transactionDuplicate";

describe("transactionDuplicate utilities", () => {
  it("builds stable duplicate keys for bank settlement", () => {
    const playerId = new Types.ObjectId();
    const bankId = new Types.ObjectId();
    const transactionAt = new Date("2026-09-01T14:00:00.000Z");

    const key = buildTransactionDuplicateKey({
      playerId,
      settlementType: "bank",
      settlementAccountId: bankId,
      amount: 300,
      transactionAt,
      utr: "acc-123",
      timeZone: "Asia/Kolkata",
    });

    expect(key).toBe(
      `${String(playerId)}|bank:${String(bankId)}|300|2026-09-01|ACC-123`,
    );
  });

  it("uses liability person id for person settlement keys", () => {
    const playerId = new Types.ObjectId();
    const personId = new Types.ObjectId();
    const transactionAt = new Date("2026-09-01T10:00:00.000Z");

    const key = buildTransactionDuplicateKey({
      playerId,
      settlementType: "person",
      settlementAccountId: personId,
      amount: 150.5,
      transactionAt,
      utr: "ref-1",
      timeZone: "Asia/Kolkata",
    });

    expect(key).toContain(`person:${String(personId)}`);
    expect(key).toContain("|150.5|2026-09-01|REF-1");
  });

  it("builds calendar-day range in the requested timezone", () => {
    const transactionAt = new Date("2026-09-01T18:30:00.000Z");
    const { start, end, ymd } = buildTransactionDayRange(transactionAt, "Asia/Kolkata");

    expect(ymd).toBe("2026-09-02");
    expect(start.toISOString()).toBe("2026-09-01T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-09-02T18:29:59.999Z");
  });

  it("changes duplicate key when amount differs", () => {
    const base = {
      playerId: new Types.ObjectId(),
      settlementType: "bank" as const,
      settlementAccountId: new Types.ObjectId(),
      transactionAt: new Date("2026-09-01T12:00:00.000Z"),
      utr: "same-ref",
      timeZone: "Asia/Kolkata",
    };

    const keyA = buildTransactionDuplicateKey({ ...base, amount: 100 });
    const keyB = buildTransactionDuplicateKey({ ...base, amount: 200 });

    expect(keyA).not.toBe(keyB);
  });
});
