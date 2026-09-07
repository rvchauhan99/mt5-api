import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { logger } from "../shared/logger";

const ENTRY_COLLECTIONS = ["liabilityentries"] as const;
const PERSON_COLLECTIONS = ["liabilitypeople", "liabilitypersons"] as const;

/**
 * Deposit person-settlement entries were incorrectly posted as Person → Deposit
 * (person credit / platform receivable ↓), same direction as withdrawal.
 * Correct direction is Deposit → Person (person debit / platform receivable ↑),
 * the reverse of withdrawal settlements.
 */
export const migration007FlipDepositLiabilityLegs = {
  id: "007_flip_deposit_liability_legs" as const,

  async up(db: Db): Promise<void> {
    const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));
    const entryCollection = ENTRY_COLLECTIONS.find((name) => existingCollections.has(name));

    if (!entryCollection) {
      logger.info(
        {
          migrationId: migration007FlipDepositLiabilityLegs.id,
          checkedCollections: [...ENTRY_COLLECTIONS],
        },
        "liability entry collection not found; skipping migration",
      );
      return;
    }

    const entries = db.collection(entryCollection);
    const wrongFilter = {
      sourceType: "deposit",
      fromAccountType: "person",
      toAccountType: "deposit",
    };

    const wrongRows = await entries
      .find(wrongFilter)
      .project({ _id: 1, fromAccountId: 1, toAccountId: 1 })
      .toArray();

    if (wrongRows.length === 0) {
      logger.info(
        { migrationId: migration007FlipDepositLiabilityLegs.id, swapped: 0 },
        "deposit liability leg migration summary",
      );
      return;
    }

    const personIds = new Set<string>();
    let swapped = 0;

    for (const row of wrongRows) {
      const personId = row.fromAccountId as ObjectId;
      const depositId = row.toAccountId as ObjectId;
      personIds.add(String(personId));

      const result = await entries.updateOne(
        { _id: row._id },
        {
          $set: {
            fromAccountType: "deposit",
            fromAccountId: depositId,
            toAccountType: "person",
            toAccountId: personId,
          },
        },
      );
      if (result.modifiedCount > 0) swapped += 1;
    }

    const personCollection = PERSON_COLLECTIONS.find((name) => existingCollections.has(name));
    let personsRecomputed = 0;

    if (personCollection && personIds.size > 0) {
      const persons = db.collection(personCollection);
      for (const personIdStr of personIds) {
        if (!ObjectId.isValid(personIdStr)) continue;
        const pid = new ObjectId(personIdStr);

        const [creditAgg, debitAgg] = await Promise.all([
          entries
            .aggregate<{ total: number }>([
              { $match: { fromAccountType: "person", fromAccountId: pid } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ])
            .toArray(),
          entries
            .aggregate<{ total: number }>([
              { $match: { toAccountType: "person", toAccountId: pid } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ])
            .toArray(),
        ]);

        const totalCredits = Number(creditAgg[0]?.total ?? 0);
        const totalDebits = Number(debitAgg[0]?.total ?? 0);
        const person = await persons.findOne({ _id: pid }, { projection: { openingBalance: 1 } });
        if (!person) continue;

        const openingBalance = Number(person.openingBalance ?? 0);
        const closingBalance = openingBalance + totalCredits - totalDebits;

        await persons.updateOne(
          { _id: pid },
          {
            $set: {
              totalCredits,
              totalDebits,
              closingBalance,
            },
          },
        );
        personsRecomputed += 1;
      }
    }

    logger.info(
      {
        migrationId: migration007FlipDepositLiabilityLegs.id,
        entryCollection,
        matched: wrongRows.length,
        swapped,
        personsRecomputed,
      },
      "deposit liability leg migration summary",
    );
  },
};
