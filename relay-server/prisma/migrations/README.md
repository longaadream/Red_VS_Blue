# Relay database migration runbook

Run these commands from `relay-server/` with the target PostgreSQL
`DATABASE_URL` set for that shell. Never use `db:push` for a persistent or
production Relay database.

For a fresh empty database, apply both migrations in order:

```sh
bun run db:migrate
```

For an existing non-empty database that was created with Prisma `db push`, first
take a database backup and verify that the existing `Room`,
`LeaderboardPlayer`, and `BattleRecord` tables match the pre-RED-119 baseline.
Then register only the baseline as already applied and deploy the nullable map
column migration:

```sh
bunx prisma migrate resolve --schema prisma/schema.prisma --applied 20260827100000_relay_schema_baseline
bun run db:migrate
```

Do not mark the baseline as applied on an empty database: `migrate deploy` must
create the three tables there. Do not mark the map migration as applied before
confirming that `Room.mapId` exists. The RED-119 map migration deliberately
leaves legacy rows as `NULL`; application routes reject those rooms before any
pre-battle write.

RED-119 validation is write-free in this repository (`prisma validate` and SQL
contract tests). A real one-time PostgreSQL rehearsal of both the fresh and
baselined-existing paths remains required before production deployment.
