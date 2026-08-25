import type { Db } from "mongodb";

/** Legacy collection names that may exist from an old notification feature; safe no-ops if absent. */
const LEGACY_NOTIFICATION_COLLECTIONS = ["notifications", "notification"] as const;

export const migration001DropNotificationCollections = {
  id: "001_drop_notification_collections" as const,

  async up(db: Db): Promise<void> {
    const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
    for (const name of LEGACY_NOTIFICATION_COLLECTIONS) {
      if (!existing.has(name)) continue;
      await db.dropCollection(name);
    }
  },
};
