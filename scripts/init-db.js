/**
 * init-db.js — Initialise the packaged client's SQLite database.
 *
 * Usage: node init-db.js <database-url>
 *
 * The packaged client ships a standalone Node runtime but does not guarantee
 * an independently loadable .prisma/client directory. Use Node's built-in
 * SQLite driver for the fixed schema DDL instead of skipping initialization.
 */
'use strict'

const { DatabaseSync } = require('node:sqlite')

const [, , dbUrl] = process.argv
if (!dbUrl || !dbUrl.startsWith('file:') || dbUrl.length === 'file:'.length) {
  console.error('[init-db] Usage: node init-db.js <file:database-path>')
  process.exit(1)
}

const databasePath = dbUrl.slice('file:'.length)
const database = new DatabaseSync(databasePath)

function ensureColumn(tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info("${tableName}")`).all()
  if (columns.some((column) => column.name === columnName)) return
  database.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`)
}

function main() {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id"           TEXT NOT NULL PRIMARY KEY,
        "username"     TEXT NOT NULL UNIQUE,
        "passwordHash" TEXT NOT NULL,
        "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "Room" (
        "id"                            TEXT NOT NULL PRIMARY KEY,
        "name"                          TEXT NOT NULL,
        "status"                        TEXT NOT NULL DEFAULT 'waiting',
        "mapId"                         TEXT,
        "hostId"                        TEXT,
        "visibility"                    TEXT,
        "maxPlayers"                    INTEGER,
        "players"                       TEXT NOT NULL DEFAULT '[]',
        "spectators"                    TEXT NOT NULL DEFAULT '[]',
        "battleState"                   TEXT,
        "inviteCode"                    TEXT,
        "createdAt"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "version"                       INTEGER NOT NULL DEFAULT 0,
        "battleAuthorityVersion"        INTEGER NOT NULL DEFAULT 0,
        "battleAuthorityTransitionHash" TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS "GameRecord" (
        "id"             TEXT NOT NULL PRIMARY KEY,
        "playerId"       TEXT NOT NULL,
        "playerName"     TEXT NOT NULL,
        "opponentId"     TEXT,
        "opponentName"   TEXT,
        "result"         TEXT NOT NULL,
        "turns"          INTEGER NOT NULL,
        "myPieces"       TEXT NOT NULL,
        "opponentPieces" TEXT NOT NULL,
        "roomId"         TEXT,
        "mapId"          TEXT,
        "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "BattleAuthorityTransition" (
        "roomId"                 TEXT NOT NULL,
        "fromVersion"            INTEGER NOT NULL,
        "toVersion"              INTEGER NOT NULL,
        "protocolVersion"        INTEGER NOT NULL,
        "clientActionId"         TEXT NOT NULL,
        "playerId"               TEXT NOT NULL,
        "commandJson"            TEXT NOT NULL,
        "internalPatch"          TEXT NOT NULL,
        "publicPatch"            TEXT NOT NULL,
        "preStateHash"           TEXT NOT NULL,
        "postStateHash"          TEXT NOT NULL,
        "prePublicHash"          TEXT NOT NULL,
        "postPublicHash"         TEXT NOT NULL,
        "actionHash"             TEXT NOT NULL DEFAULT '',
        "previousTransitionHash" TEXT NOT NULL DEFAULT '',
        "transitionHash"         TEXT NOT NULL DEFAULT '',
        "pendingJson"            TEXT,
        "traceJson"              TEXT,
        "replayFrameJson"        TEXT,
        "createdAt"              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("roomId", "toVersion")
      );

      CREATE TABLE IF NOT EXISTS "BattleAuthorityReceipt" (
        "roomId"           TEXT NOT NULL,
        "clientActionId"   TEXT NOT NULL,
        "status"           TEXT NOT NULL,
        "authorityVersion" INTEGER NOT NULL,
        "code"             TEXT,
        "message"          TEXT,
        "receiptJson"      TEXT NOT NULL,
        "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("roomId", "clientActionId")
      );

      CREATE TABLE IF NOT EXISTS "BattleAuthorityCheckpoint" (
        "roomId"           TEXT NOT NULL,
        "authorityVersion" INTEGER NOT NULL,
        "protocolVersion"  INTEGER NOT NULL,
        "seed"             INTEGER NOT NULL,
        "stateJson"        TEXT NOT NULL,
        "stateHash"        TEXT NOT NULL,
        "publicHash"       TEXT NOT NULL,
        "transitionHash"   TEXT NOT NULL DEFAULT '',
        "reason"           TEXT NOT NULL,
        "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("roomId", "authorityVersion")
      );
    `)

    // Databases created by older packaged clients do not have a Prisma
    // migration ledger. Add only missing columns and surface all other SQL
    // failures so the Electron startup cannot silently run with a broken DB.
    ensureColumn('Room', 'spectators', `TEXT NOT NULL DEFAULT '[]'`)
    ensureColumn('Room', 'inviteCode', 'TEXT')
    ensureColumn('Room', 'battleAuthorityVersion', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn('Room', 'battleAuthorityTransitionHash', `TEXT NOT NULL DEFAULT ''`)
    ensureColumn('BattleAuthorityTransition', 'actionHash', `TEXT NOT NULL DEFAULT ''`)
    ensureColumn('BattleAuthorityTransition', 'previousTransitionHash', `TEXT NOT NULL DEFAULT ''`)
    ensureColumn('BattleAuthorityTransition', 'transitionHash', `TEXT NOT NULL DEFAULT ''`)
    ensureColumn('BattleAuthorityCheckpoint', 'transitionHash', `TEXT NOT NULL DEFAULT ''`)

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS "BattleAuthorityTransition_roomId_clientActionId_key"
      ON "BattleAuthorityTransition"("roomId", "clientActionId");

      CREATE INDEX IF NOT EXISTS "BattleAuthorityTransition_roomId_fromVersion_idx"
      ON "BattleAuthorityTransition"("roomId", "fromVersion");

      CREATE INDEX IF NOT EXISTS "BattleAuthorityReceipt_roomId_authorityVersion_idx"
      ON "BattleAuthorityReceipt"("roomId", "authorityVersion");

      CREATE INDEX IF NOT EXISTS "BattleAuthorityCheckpoint_roomId_createdAt_idx"
      ON "BattleAuthorityCheckpoint"("roomId", "createdAt");
    `)

    database.exec('COMMIT')
    console.log('[init-db] Tables created (or already exist).')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      console.error(
        '[init-db] Rollback failed:',
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      )
    }
    throw error
  }
}

try {
  main()
} catch (error) {
  console.error('[init-db] Error:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  database.close()
}
