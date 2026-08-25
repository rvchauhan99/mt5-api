# Withdrawal legacy data (pre deposit-style UX)

Older `Withdrawal` documents may have only: `playerName`, `bankName`, `amount`, `stage`, `status`, `utr`, `createdBy` — without `player`, beneficiary account fields (`accountNumber`, `accountHolderName`, `ifsc`), `reverseBonus`, `payableAmount`, or `payoutBankId`.

The API now lists by **`view`** (`exchange` | `banker` | `final`) instead of relying on `stage` for navigation. Legacy rows remain readable; optional fields default in the schema.

## Optional backfill (MongoDB)

Run only if you need full reporting on old rows:

1. Set `accountNumber` / `accountHolderName` / `ifsc` to empty strings where missing.
2. Set `reverseBonus` to `0` and `payableAmount` to `amount` where `payableAmount` is missing.
3. If you can resolve a player document from `playerName`, set `player` to that `ObjectId`.

Example (adjust collection name):

```js
db.withdrawals.updateMany(
  { payableAmount: { $exists: false } },
  [{ $set: { payableAmount: "$amount", reverseBonus: { $ifNull: ["$reverseBonus", 0] } } }]
);
```

Note: aggregation-style `$set` in update may require pipeline updates (MongoDB 4.2+). Alternatively update in application code or one-off script.

## Index

No new indexes are required for the withdrawal schema beyond defaults. Monitor query performance on `status`, `createdAt`, and `player` if lists grow large.
