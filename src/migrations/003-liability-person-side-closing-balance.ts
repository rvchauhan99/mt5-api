import type { Db } from "mongodb";
import { logger } from "../shared/logger";

const CANDIDATE_COLLECTIONS = ["liabilitypeople", "liabilitypersons"] as const;

export const migration003LiabilityPersonSideClosingBalance = {
  id: "003_liability_person_side_closing_balance" as const,

  async up(db: Db): Promise<void> {
    const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));
    const targetCollection = CANDIDATE_COLLECTIONS.find((name) => existingCollections.has(name));

    if (!targetCollection) {
      logger.info(
        {
          migrationId: "003_liability_person_side_closing_balance",
          checkedCollections: [...CANDIDATE_COLLECTIONS],
        },
        "liability person collection not found; skipping migration",
      );
      return;
    }

    const result = await db.collection(targetCollection).updateMany(
      {},
      [
        {
          $set: {
            closingBalance: {
              $add: [
                {
                  $subtract: [{ $ifNull: ["$openingBalance", 0] }, { $ifNull: ["$totalDebits", 0] }],
                },
                { $ifNull: ["$totalCredits", 0] },
              ],
            },
          },
        },
      ],
    );

    logger.info(
      {
        migrationId: "003_liability_person_side_closing_balance",
        collection: targetCollection,
        matched: result.matchedCount ?? 0,
        modified: result.modifiedCount ?? 0,
      },
      "liability person closing balance migration summary",
    );
  },
};
