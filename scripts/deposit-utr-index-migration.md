# Deposit UTR index migration (partial unique, exclude rejected)

Deployments that already have a **global unique index** on `deposits.utr` (typically named `utr_1`) must drop it **once** before Mongoose can create the new **partial** unique index defined in `src/modules/deposit/deposit.model.ts`.

Without this step, MongoDB will keep enforcing uniqueness on all rows including rejected deposits, or index creation may fail.

## Steps

1. Connect to the database (mongosh or Compass).

2. Inspect indexes on the `deposits` collection:

   ```js
   db.deposits.getIndexes()
   ```

3. Drop the legacy unique index on `utr` (name may be `utr_1`):

   ```js
   db.deposits.dropIndex("utr_1")
   ```

   If the name differs, use the `name` field from `getIndexes()`.

4. Create the partial unique index (or restart the API if your process calls `syncIndexes()` / equivalent):

   ```js
   db.deposits.createIndex(
     { utr: 1 },
     {
       unique: true,
       partialFilterExpression: { status: { $ne: "rejected" } },
       name: "utr_1_partial_non_rejected",
     }
   )
   ```

   If you omit `name`, MongoDB will assign one; ensure no duplicate index on `utr` with different options.

5. Verify:

   ```js
   db.deposits.getIndexes()
   ```

   You should see the partial unique index; the old full `utr` unique index should be gone.

## Data caveat

If two **non-rejected** documents already share the same `utr`, the new unique index **cannot** be created until duplicates are resolved manually.
