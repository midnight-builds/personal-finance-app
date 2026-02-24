# Backup & restore (SQLite)

This app is single-user and stores data in a local SQLite DB.

- Default DB path: `apps/api/data/finance.db` (configurable via `DB_PATH`)
- **Before backup/restore:** stop the API process (or at least ensure nothing is writing to the DB).

## Backup

Creates a consistent copy using SQLite `VACUUM INTO`.

```bash
# from repo root
npm run backup --workspace apps/api

# optional: choose output path
npm run backup --workspace apps/api -- --out /path/to/finance-backup.db

# optional: choose DB path
DB_PATH=/path/to/finance.db npm run backup --workspace apps/api
```

Backups are written to `apps/api/backups/` by default.

## Restore

```bash
# from repo root
npm run restore --workspace apps/api -- --from apps/api/backups/finance-<timestamp>.db --force

# optional: restore to a custom DB path
npm run restore --workspace apps/api -- --from ./my.db --db /path/to/finance.db --force
```

Notes:
- `--force` is required if the target DB already exists.
- The restore script removes any `-wal` / `-shm` sidecar files for the target DB path.

## Fresh machine restore checklist

1) Install deps (`npm ci`)
2) Copy your backup DB to the machine
3) Restore into the expected `DB_PATH`
4) Start the app (`npm run dev` or production start)

