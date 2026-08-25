# Player Async Import Rollout Checklist

## Feature Flag
- Frontend flag: `NEXT_PUBLIC_PLAYER_IMPORT_ASYNC_ENABLED`
- Default behavior: async import enabled.
- Rollback behavior: set flag to `false` to use legacy synchronous `/players/import`.

## Pre-Prod Validation
- Upload `100` rows and confirm status transitions from `queued` -> `processing` -> `completed`.
- Upload `10,000` rows and verify API request returns `202` quickly (no timeout).
- Confirm progress counts update in realtime (`processedRows`, `successRows`, `failedRows`, `skippedRows`).
- Confirm polling fallback keeps updating status when stream reconnects or closes.
- Validate failed import shows row-level errors in `errorSample`.

## Production Rollout
- Deploy backend first (new endpoints and worker).
- Deploy frontend with async flag enabled for internal users.
- Monitor import job failures and worker logs for 24 hours.
- Enable async flag for all users.
- Keep legacy `/players/import` route available for one release cycle, then deprecate.
