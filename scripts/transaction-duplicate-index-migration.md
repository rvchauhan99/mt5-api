# Composite transaction duplicate index migration

Deployments that have **legacy unique indexes on `utr` alone** on `deposits` and `withdrawals` must drop them before the API can create the new **partial unique `duplicateKey`** indexes.

The `duplicateKey` field encodes: trader + settlement account (bank or liability person) + platform amount + calendar transaction date + reference number.

## Steps

1. Connect to MongoDB (`mongosh` or Compass).

2. Inspect indexes:

   ```js
   db.deposits.getIndexes()
   db.withdrawals.getIndexes()
   ```

3. Drop legacy `utr` unique indexes if present (names may vary, e.g. `utr_1`):

   ```js
   db.deposits.dropIndex("utr_1")
   db.withdrawals.dropIndex("utr_1")
   ```

4. Restart the API (or run `syncIndexes`) so Mongoose creates:

   - `deposits.duplicateKey_1` (partial unique, `status != rejected`)
   - `withdrawals.duplicateKey_1` (partial unique, `status != rejected`)

5. Verify:

   ```js
   db.deposits.getIndexes()
   db.withdrawals.getIndexes()
   ```

## Data caveat

If two **non-rejected** documents already share the same composite fingerprint, index creation may fail until duplicates are resolved. New writes set `duplicateKey` on create/import/amend.

## Reference number reuse

After this migration, the **same reference number** may appear on multiple transactions when amount, trader, bank/person, or date differ.
