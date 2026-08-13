import { spawnSync } from 'child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve(__dirname, '../..')
const initScript = path.join(projectRoot, 'scripts', 'init-db.js')
const moduleRoot = path.join(projectRoot, 'node_modules')
const migrationsDir = path.join(projectRoot, 'prisma', 'migrations')
const temporaryDirectories: string[] = []

function createDatabaseUrl(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'rvb-red14-db-'))
  temporaryDirectories.push(directory)
  return `file:${path.join(directory, 'game.db').replace(/\\/g, '/')}`
}

function runInit(databaseUrl: string) {
  return spawnSync(
    process.execPath,
    [initScript, databaseUrl, moduleRoot, migrationsDir],
    { cwd: projectRoot, encoding: 'utf8' },
  )
}

function createClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SQLite migration initialization', () => {
  it('creates the current schema in a missing database', async () => {
    const databaseUrl = createDatabaseUrl()

    const result = runInit(databaseUrl)

    expect(result.status, result.stderr).toBe(0)
    const prisma = createClient(databaseUrl)
    await expect(prisma.room.findMany()).resolves.toEqual([])
    await expect(prisma.gameRecord.findMany()).resolves.toEqual([])
    await prisma.$disconnect()
  })

  it('can apply the same migrations repeatedly', async () => {
    const databaseUrl = createDatabaseUrl()

    const first = runInit(databaseUrl)
    const second = runInit(databaseUrl)

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    const prisma = createClient(databaseUrl)
    const migrations = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*) AS count FROM "_prisma_migrations"',
    )
    expect(Number(migrations[0].count)).toBe(3)
    await prisma.$disconnect()
  })

  it('preserves existing data during repeated initialization', async () => {
    const databaseUrl = createDatabaseUrl()
    expect(runInit(databaseUrl).status).toBe(0)
    const before = createClient(databaseUrl)
    await before.user.create({
      data: { id: 'existing-user', username: 'existing-user', passwordHash: 'unchanged' },
    })
    await before.$disconnect()

    const repeated = runInit(databaseUrl)

    expect(repeated.status, repeated.stderr).toBe(0)
    const after = createClient(databaseUrl)
    await expect(after.user.findUnique({ where: { id: 'existing-user' } })).resolves.toMatchObject({
      username: 'existing-user',
      passwordHash: 'unchanged',
    })
    await after.$disconnect()
  })

  it('preserves room data while upgrading the original migration schema', async () => {
    const databaseUrl = createDatabaseUrl()
    const before = createClient(databaseUrl)
    const initialSql = readFileSync(
      path.join(migrationsDir, '20260317092654_init', 'migration.sql'),
      'utf8',
    )
    const initialStatements = initialSql
      .replace(/^--.*$/gm, '')
      .split(';')
      .map(statement => statement.trim())
      .filter(Boolean)
    for (const statement of initialStatements) await before.$executeRawUnsafe(statement)
    await before.$executeRawUnsafe(
      `INSERT INTO "Room" ("id", "name", "players", "updatedAt") VALUES (?, ?, ?, ?)`,
      'existing-room',
      'Existing room',
      '[{"id":"player-1"}]',
      '2026-08-13T00:00:00.000Z',
    )
    await before.$disconnect()

    const upgraded = runInit(databaseUrl)

    expect(upgraded.status, upgraded.stderr).toBe(0)
    const after = createClient(databaseUrl)
    await expect(after.room.findUnique({ where: { id: 'existing-room' } })).resolves.toMatchObject({
      name: 'Existing room',
      players: '[{"id":"player-1"}]',
      spectators: '[]',
    })
    await after.$disconnect()
  })

  it('baselines a database created by the former initializer without losing data', async () => {
    const databaseUrl = createDatabaseUrl()
    const legacy = createClient(databaseUrl)
    const legacySql = readFileSync(
      path.join(projectRoot, 'tests', 'database', 'fixtures', 'former-init-db.sql'),
      'utf8',
    )
    for (const statement of legacySql.split(';').map(item => item.trim()).filter(Boolean)) {
      await legacy.$executeRawUnsafe(statement)
    }
    await legacy.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "username", "passwordHash") VALUES (?, ?, ?)`,
      'legacy-user',
      'legacy-user',
      'keep-me',
    )
    await legacy.$executeRawUnsafe(
      `INSERT INTO "Room" ("id", "name", "players") VALUES (?, ?, ?)`,
      'legacy-room',
      'Legacy room',
      '[{"id":"legacy-player"}]',
    )
    await legacy.$disconnect()

    const result = runInit(databaseUrl)

    expect(result.status, result.stderr).toBe(0)
    const after = createClient(databaseUrl)
    await expect(after.user.findUnique({ where: { id: 'legacy-user' } })).resolves.toMatchObject({
      passwordHash: 'keep-me',
    })
    await expect(after.room.findUnique({ where: { id: 'legacy-room' } })).resolves.toMatchObject({
      name: 'Legacy room',
      players: '[{"id":"legacy-player"}]',
    })
    const migrations = await after.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*) AS count FROM "_prisma_migrations"',
    )
    expect(Number(migrations[0].count)).toBe(3)
    await after.$disconnect()
  })

  it('rejects an unknown schema without adding migration metadata', async () => {
    const databaseUrl = createDatabaseUrl()
    const unknown = createClient(databaseUrl)
    await unknown.$executeRawUnsafe('CREATE TABLE "Room" ("id" TEXT PRIMARY KEY)')
    await unknown.$disconnect()

    const result = runInit(databaseUrl)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unrecognized existing database schema')
    const inspect = createClient(databaseUrl)
    const metadata = await inspect.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'`,
    )
    expect(metadata).toEqual([])
    await inspect.$disconnect()
  })

  it('rejects a damaged schema even when migration records exist', async () => {
    const databaseUrl = createDatabaseUrl()
    expect(runInit(databaseUrl).status).toBe(0)
    const damaged = createClient(databaseUrl)
    await damaged.$executeRawUnsafe('DROP TABLE "Room"')
    await damaged.$disconnect()

    const result = runInit(databaseUrl)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Database schema validation failed')
  })

  it('rejects an unresolved migration record without retrying migration SQL', async () => {
    const databaseUrl = createDatabaseUrl()
    expect(runInit(databaseUrl).status).toBe(0)
    const interrupted = createClient(databaseUrl)
    await interrupted.$executeRawUnsafe(
      `UPDATE "_prisma_migrations" SET "finished_at" = NULL WHERE "migration_name" = ?`,
      '20260813184000_normalize_sqlite_types',
    )
    await interrupted.$disconnect()

    const result = runInit(databaseUrl)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Database contains an unresolved migration: 20260813184000_normalize_sqlite_types',
    )
  })

  it('finds migrations beside a packaged initializer', async () => {
    const databaseUrl = createDatabaseUrl()
    const packagedRoot = mkdtempSync(path.join(tmpdir(), 'rvb-red14-packaged-'))
    temporaryDirectories.push(packagedRoot)
    const appRoot = path.join(packagedRoot, 'app')
    mkdirSync(appRoot)
    copyFileSync(initScript, path.join(appRoot, 'init-db.js'))
    cpSync(migrationsDir, path.join(appRoot, 'prisma', 'migrations'), { recursive: true })

    const result = spawnSync(
      process.execPath,
      [path.join(appRoot, 'init-db.js'), databaseUrl, moduleRoot],
      { cwd: projectRoot, encoding: 'utf8' },
    )

    expect(result.status, result.stderr).toBe(0)
    const prisma = createClient(databaseUrl)
    await expect(prisma.room.findMany()).resolves.toEqual([])
    await prisma.$disconnect()
  })

  it('rejects a legacy-shaped database whose unique constraint is missing', async () => {
    const databaseUrl = createDatabaseUrl()
    expect(runInit(databaseUrl).status).toBe(0)
    const damaged = createClient(databaseUrl)
    await damaged.$executeRawUnsafe('DROP TABLE "_prisma_migrations"')
    await damaged.$executeRawUnsafe('DROP INDEX "User_username_key"')
    await damaged.$disconnect()

    const result = runInit(databaseUrl)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unrecognized existing database schema')
  })

  it('rejects a legacy-shaped database whose primary key is missing', async () => {
    const databaseUrl = createDatabaseUrl()
    expect(runInit(databaseUrl).status).toBe(0)
    const damaged = createClient(databaseUrl)
    await damaged.$executeRawUnsafe('DROP TABLE "_prisma_migrations"')
    await damaged.$executeRawUnsafe(`
      CREATE TABLE "GameRecord_damaged" (
        "id" TEXT NOT NULL,
        "playerId" TEXT NOT NULL,
        "playerName" TEXT NOT NULL,
        "opponentId" TEXT,
        "opponentName" TEXT,
        "result" TEXT NOT NULL,
        "turns" INTEGER NOT NULL,
        "myPieces" TEXT NOT NULL,
        "opponentPieces" TEXT NOT NULL,
        "roomId" TEXT,
        "mapId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await damaged.$executeRawUnsafe('DROP TABLE "GameRecord"')
    await damaged.$executeRawUnsafe('ALTER TABLE "GameRecord_damaged" RENAME TO "GameRecord"')
    await damaged.$disconnect()

    const result = runInit(databaseUrl)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unrecognized existing database schema')
  })

  it('rolls back all statements and metadata when a migration fails', async () => {
    const databaseUrl = createDatabaseUrl()
    const failingMigrations = mkdtempSync(path.join(tmpdir(), 'rvb-red14-failing-migrations-'))
    temporaryDirectories.push(failingMigrations)
    const initialTarget = path.join(failingMigrations, '20260317092654_init')
    mkdirSync(initialTarget)
    copyFileSync(
      path.join(migrationsDir, '20260317092654_init', 'migration.sql'),
      path.join(initialTarget, 'migration.sql'),
    )
    for (const migrationName of [
      '20260813181000_complete_initial_schema',
      '20260813184000_normalize_sqlite_types',
    ]) {
      cpSync(
        path.join(migrationsDir, migrationName),
        path.join(failingMigrations, migrationName),
        { recursive: true },
      )
    }
    const failingTarget = path.join(failingMigrations, '20260813190000_injected_failure')
    mkdirSync(failingTarget)
    writeFileSync(
      path.join(failingTarget, 'migration.sql'),
      'CREATE TABLE "MustRollback" ("id" TEXT PRIMARY KEY);\nTHIS IS NOT VALID SQL;',
    )

    const result = spawnSync(
      process.execPath,
      [initScript, databaseUrl, moduleRoot, failingMigrations],
      { cwd: projectRoot, encoding: 'utf8' },
    )

    expect(result.status).toBe(1)
    const inspect = createClient(databaseUrl)
    const table = await inspect.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'MustRollback'`,
    )
    expect(table).toEqual([])
    const failedRecord = await inspect.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "_prisma_migrations" WHERE "migration_name" = '20260813190000_injected_failure'`,
    )
    expect(Number(failedRecord[0].count)).toBe(0)
    await inspect.$disconnect()
    expect(existsSync(databaseUrl.slice('file:'.length))).toBe(true)
  })
})
