# Thesis DB Migrations

Incremental, tracked, transactional migrations for the Thesis PostgreSQL database.

## Files

- `scripts/migrate-v2.js` — the runner
- `sql/migrations/*.sql` — migration files (sorted alphabetically by filename)
- `sql/schema.sql` — authoritative full schema for fresh environments (still used)
- Tracking table: `schema_migrations` (auto-created on first run)

## Naming convention

`YYYYMMDD_HHMM_short_description.sql` (UTC timestamps)

Examples:
- `20260721_1200_baseline.sql`
- `20260721_1201_add_energeies_dikigoroi_junction.sql`
- `20260722_0930_add_column_foo_to_bar.sql`

Filenames sort alphabetically → execution order is deterministic.

## Commands

```bash
npm run migrate:status        # show applied and pending
npm run migrate:up            # apply pending migrations
npm run migrate:up -- --dry-run   # show what would run, no changes
npm run migrate:baseline      # mark all current files as applied (bootstrap only)
```

On Railway you can run any of these via:

```bash
railway run --service Postgres npm run migrate:status
```

Or connect to the thesis-web service and run without --service flag.

## First-time bootstrap

If the database already has schema (from `sql/schema.sql` or manual work), run baseline **once**:

```bash
railway run --service Postgres npm run migrate:baseline
```

This marks every existing migration file as applied without executing them. Future new files will run normally.

## Writing a new migration

1. Create a file in `sql/migrations/` with the naming convention above.
2. Use `IF NOT EXISTS` / `IF EXISTS` clauses where possible for idempotency.
3. Each file runs in its own transaction — no need for explicit `BEGIN`/`COMMIT`.
4. Test locally with `--dry-run` first.
5. Commit the file.
6. On next deploy (or manual `migrate:up`), it will be applied automatically.

## Forward-only policy

We do not maintain down/rollback migrations. If a migration causes issues:

1. Revert the application code that depends on the new schema.
2. Write a **new** forward migration that reverses the change (e.g. drop the added column).
3. Never edit a migration file that has already been applied to production.

## Auto-run on deploy (optional, Phase 4)

To make migrations run automatically on Railway deploy, change the `start`
script in `package.json` from:

```json
"start": "node src/server.js"
```

to:

```json
"start": "node scripts/migrate-v2.js && node src/server.js"
```

**Warning**: if migration fails, the app will not start (crash-safe — Railway
keeps the previous deployment alive). This is the desired behavior for prod.

Do NOT enable auto-run until you have verified `migrate:status` and `migrate:up`
work correctly manually.
