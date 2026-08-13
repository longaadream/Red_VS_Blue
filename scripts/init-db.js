/**
 * Apply committed SQLite migrations without the Prisma schema engine.
 *
 * Usage: node init-db.js <database-url> <node-modules-dir> [migrations-dir]
 *
 * The migration SQL under prisma/migrations is the only executable schema
 * history. This runner uses Prisma's packaged query engine, so it also works
 * in Electron builds where `prisma migrate deploy` is unavailable.
 */
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const [, , dbUrl, moduleRoot, migrationsArgument] = process.argv
if (!dbUrl || !moduleRoot) {
  console.error('[init-db] Usage: node init-db.js <database-url> <node-modules-dir> [migrations-dir]')
  process.exit(1)
}

const migrationsDir = migrationsArgument || [
  path.resolve(__dirname, '..', 'prisma', 'migrations'),
  path.resolve(__dirname, 'prisma', 'migrations'),
].find(candidate => fs.existsSync(candidate)) || path.resolve(__dirname, '..', 'prisma', 'migrations')
process.env.DATABASE_URL = dbUrl

const clientPath = path.join(path.resolve(moduleRoot), '.prisma', 'client')
let PrismaClient
try {
  PrismaClient = require(clientPath).PrismaClient
} catch (error) {
  console.error('[init-db] Cannot load PrismaClient from', clientPath, error.message)
  process.exit(1)
}

const prisma = new PrismaClient()
const METADATA_TABLE = '_prisma_migrations'
const INITIAL_MIGRATION = '20260317092654_init'
const COMPLETE_SCHEMA_MIGRATION = '20260813181000_complete_initial_schema'

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex')
}

function splitStatements(sql) {
  const statements = []
  let current = ''
  let quote = null
  let lineComment = false

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (!quote && char === '-' && next === '-') {
      lineComment = true
      index += 1
      continue
    }
    if (quote) {
      current += char
      if (char === quote) {
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += char
  }

  if (quote) throw new Error('Migration contains an unterminated quoted value')
  if (current.trim()) statements.push(current.trim())
  return statements
}

function loadMigrations() {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`)
  }
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const sqlPath = path.join(migrationsDir, entry.name, 'migration.sql')
      if (!fs.existsSync(sqlPath)) throw new Error(`Missing migration.sql: ${sqlPath}`)
      const sql = fs.readFileSync(sqlPath, 'utf8')
      return { name: entry.name, sql, checksum: checksum(sql), statements: splitStatements(sql) }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function databaseShape(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
  const tables = rows.map(row => row.name).filter(name => name !== METADATA_TABLE)
  const shape = []
  for (const table of tables) {
    const escapedTable = table.replace(/"/g, '""')
    const columns = await client.$queryRawUnsafe(`PRAGMA table_info("${escapedTable}")`)
    const indexes = await client.$queryRawUnsafe(`PRAGMA index_list("${escapedTable}")`)
    const indexShapes = []
    for (const index of indexes) {
      const escapedIndex = index.name.replace(/"/g, '""')
      const indexColumns = await client.$queryRawUnsafe(`PRAGMA index_info("${escapedIndex}")`)
      indexShapes.push({
        unique: Number(index.unique),
        partial: Number(index.partial),
        columns: indexColumns.sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map(column => column.name),
      })
    }
    indexShapes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    shape.push({
      table,
      columns: columns.sort((left, right) => Number(left.cid) - Number(right.cid)).map(column => ({
        name: column.name,
        type: String(column.type).trim().replace(/\s+/g, ' ').toUpperCase(),
        notNull: Number(column.notnull),
        defaultValue: column.dflt_value,
        primaryKeyPosition: Number(column.pk),
      })),
      indexes: indexShapes,
    })
  }
  return JSON.stringify(shape)
}

async function migrationShape(migrations) {
  const referencePath = path.join(os.tmpdir(), `rvb-migration-shape-${crypto.randomUUID()}.db`)
  const referenceUrl = `file:${referencePath.replace(/\\/g, '/')}`
  const reference = new PrismaClient({ datasources: { db: { url: referenceUrl } } })
  try {
    await reference.$transaction(async tx => {
      for (const migration of migrations) {
        for (const statement of migration.statements) await tx.$executeRawUnsafe(statement)
      }
    }, { maxWait: 5_000, timeout: 60_000 })
    return await databaseShape(reference)
  } finally {
    await reference.$disconnect().catch(() => {})
    for (const suffix of ['', '-journal']) {
      try { fs.rmSync(referencePath + suffix, { force: true }) } catch {}
    }
  }
}

async function formerInitializerShape(migrations) {
  const shape = JSON.parse(await migrationShape(migrations))
  const room = shape.find(item => item.table === 'Room')
  const updatedAt = room?.columns.find(column => column.name === 'updatedAt')
  if (!updatedAt || updatedAt.defaultValue !== null) {
    throw new Error('Current migrations no longer match the expected legacy Room.updatedAt baseline')
  }

  // The removed initializer matched the current migration-derived structure
  // except that Room.updatedAt also defaulted to CURRENT_TIMESTAMP. Keep this
  // as a narrow compatibility delta instead of copying its table definitions.
  updatedAt.defaultValue = 'CURRENT_TIMESTAMP'
  return JSON.stringify(shape)
}

async function identifyLegacySchema(client, migrations) {
  const actualShape = await databaseShape(client)
  if (actualShape === '[]') return []

  const initialIndex = migrations.findIndex(migration => migration.name === INITIAL_MIGRATION)
  const completeIndex = migrations.findIndex(migration => migration.name === COMPLETE_SCHEMA_MIGRATION)
  if (initialIndex < 0 || completeIndex < initialIndex) {
    throw new Error('Required baseline migrations are missing or out of order')
  }

  const initialShape = await migrationShape(migrations.slice(0, initialIndex + 1))
  if (actualShape === initialShape) return migrations.slice(0, initialIndex + 1).map(item => item.name)

  // The former initializer already created every current table/column, but
  // used slightly different SQLite type/default declarations. Compare names
  // against migration-derived shape, then let later migrations normalize it.
  const completeShape = await formerInitializerShape(migrations)
  if (actualShape === completeShape) {
    return migrations.slice(0, completeIndex + 1).map(item => item.name)
  }
  return null
}

async function metadataExists(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${METADATA_TABLE}'`,
  )
  return rows.length === 1
}

async function ensureMetadataTable(client, baselines, migrations) {
  await client.$transaction(async tx => {
    await tx.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${METADATA_TABLE}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
      )
    `)
    for (const name of baselines) {
      const migration = migrations.find(item => item.name === name)
      if (!migration) throw new Error(`Cannot baseline missing migration: ${name}`)
      await tx.$executeRawUnsafe(
        `INSERT INTO "${METADATA_TABLE}" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count") VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
        crypto.randomUUID(),
        migration.checksum,
        migration.name,
      )
    }
  })
}

async function migrationRecords(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT "migration_name", "checksum", "finished_at", "rolled_back_at" FROM "${METADATA_TABLE}" ORDER BY "started_at", "migration_name"`,
  )
  const unresolved = rows.find(row => row.finished_at === null && row.rolled_back_at === null)
  if (unresolved) {
    throw new Error(`Database contains an unresolved migration: ${unresolved.migration_name}`)
  }

  const applied = new Map()
  for (const row of rows) {
    if (row.finished_at === null || row.rolled_back_at !== null) continue
    if (applied.has(row.migration_name)) {
      throw new Error(`Database contains duplicate applied migration records: ${row.migration_name}`)
    }
    applied.set(row.migration_name, row.checksum)
  }
  return applied
}

async function applyMigration(client, migration) {
  await client.$transaction(async tx => {
    for (const statement of migration.statements) {
      await tx.$executeRawUnsafe(statement)
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "${METADATA_TABLE}" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count") VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
      crypto.randomUUID(),
      migration.checksum,
      migration.name,
    )
  }, { maxWait: 5_000, timeout: 60_000 })
  console.log(`[init-db] Applied migration ${migration.name}`)
}

async function verifyCurrentSchema(client) {
  try {
    // Prisma builds these SELECT lists from schema.prisma. A missing table or
    // column therefore fails without duplicating the schema in this runner.
    await client.user.findFirst()
    await client.room.findFirst()
    await client.gameRecord.findFirst()
  } catch (error) {
    throw new Error(`Database schema validation failed: ${error.message}`)
  }
}

async function main() {
  const migrations = loadMigrations()
  if (migrations.length === 0) throw new Error(`No migrations found in ${migrationsDir}`)

  if (!await metadataExists(prisma)) {
    const baselines = await identifyLegacySchema(prisma, migrations)
    if (baselines === null) {
      throw new Error('Unrecognized existing database schema; refusing to modify or baseline it')
    }
    await ensureMetadataTable(prisma, baselines, migrations)
    if (baselines.length > 0) {
      console.log(`[init-db] Baselined legacy schema through ${baselines[baselines.length - 1]}`)
    }
  }

  const applied = await migrationRecords(prisma)
  for (const [name] of applied) {
    if (!migrations.some(migration => migration.name === name)) {
      throw new Error(`Database contains unknown migration: ${name}`)
    }
  }
  for (const migration of migrations) {
    const recordedChecksum = applied.get(migration.name)
    if (recordedChecksum && recordedChecksum !== migration.checksum) {
      throw new Error(`Migration checksum mismatch: ${migration.name}`)
    }
    if (!recordedChecksum) await applyMigration(prisma, migration)
  }

  await verifyCurrentSchema(prisma)

  console.log('[init-db] Database migrations are current.')
}

main()
  .catch(error => {
    console.error('[init-db] Error:', error.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().catch(() => {}))
