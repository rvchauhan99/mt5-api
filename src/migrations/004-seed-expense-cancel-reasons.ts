import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { REASON_TYPES } from "../shared/constants/reasonTypes";
import { logger } from "../shared/logger";

const REASONS_COLLECTION = "reasons";
const USERS_COLLECTION = "users";

const EXPENSE_CANCEL_REASONS: { reason: string; description?: string }[] = [
  { reason: "Approved in error", description: "Expense was approved by mistake" },
  { reason: "Duplicate booking", description: "Same expense was recorded more than once" },
  { reason: "Wrong settlement account", description: "Bank or liability person was incorrect" },
  { reason: "Other (add details in remark)" },
];

export const migration004SeedExpenseCancelReasons = {
  id: "004_seed_expense_cancel_reasons" as const,

  async up(db: Db): Promise<void> {
    const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));
    if (!existingCollections.has(REASONS_COLLECTION)) {
      logger.info(
        { migrationId: migration004SeedExpenseCancelReasons.id },
        "reasons collection not found; skipping migration",
      );
      return;
    }

    const superadmin = await db
      .collection(USERS_COLLECTION)
      .findOne({ role: "superadmin", status: "active" }, { projection: { _id: 1 } });

    if (!superadmin?._id) {
      logger.warn(
        { migrationId: migration004SeedExpenseCancelReasons.id },
        "no active superadmin found; skipping expense cancel reason seed",
      );
      return;
    }

    const actorId = superadmin._id instanceof ObjectId ? superadmin._id : new ObjectId(String(superadmin._id));
    const now = new Date();
    const reasons = db.collection(REASONS_COLLECTION);

    let upserted = 0;
    for (const row of EXPENSE_CANCEL_REASONS) {
      const result = await reasons.updateOne(
        { reasonType: REASON_TYPES.EXPENSE_CANCEL, reason: row.reason },
        {
          $set: {
            description: row.description ?? "",
            isActive: true,
            deletedAt: null,
            updatedBy: actorId,
            updatedAt: now,
          },
          $setOnInsert: {
            reasonType: REASON_TYPES.EXPENSE_CANCEL,
            reason: row.reason,
            createdBy: actorId,
            createdAt: now,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) upserted += 1;
    }

    logger.info(
      {
        migrationId: migration004SeedExpenseCancelReasons.id,
        reasonType: REASON_TYPES.EXPENSE_CANCEL,
        seeded: EXPENSE_CANCEL_REASONS.length,
        newlyInserted: upserted,
      },
      "expense cancel reasons migration summary",
    );
  },
};
