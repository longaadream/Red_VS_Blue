/**
 * init-db.js — Initialise SQLite database tables for RED vs BLUE Server.
 *
 * Usage: node init-db.js <database-url> <standalone-node-modules-dir>
 *
 * Called from electron/main.ts initDatabase() to avoid relying on the
 * prisma CLI (which requires the schema-engine binary, not present in the
 * Next.js standalone output).  Instead we use the Prisma *query-engine*
 * (which IS in .prisma/client) to run raw CREATE TABLE IF NOT EXISTS SQL.
 */
'use strict'

const path = require('path')

const [, , dbUrl, moduleRoot] = process.argv
if (!dbUrl || !moduleRoot) {
  console.error('[init-db] Usage: node init-db.js <database-url> <standalone-node-modules-dir>')
  process.exit(1)
}

process.env.DATABASE_URL = dbUrl

// Load the generated Prisma client from the standalone node_modules.
// .prisma/client has the generated schema-specific code + native engine.
const clientPath = path.join(moduleRoot, '.prisma', 'client')
let PrismaClient
try {
  PrismaClient = require(clientPath).PrismaClient
} catch (e) {
  console.error('[init-db] Cannot load PrismaClient from', clientPath, e.message)
  process.exit(1)
}

const prisma = new PrismaClient()

async function main() {
  // Create tables using the exact SQLite DDL matching prisma/schema.prisma.
  // We use IF NOT EXISTS so this is always safe to re-run.

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "User" (
      "id"           TEXT NOT NULL PRIMARY KEY,
      "username"     TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT NOT NULL,
      "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Room" (
      "id"          TEXT NOT NULL PRIMARY KEY,
      "name"        TEXT NOT NULL,
      "status"      TEXT NOT NULL DEFAULT 'waiting',
      "mapId"       TEXT,
      "hostId"      TEXT,
      "visibility"  TEXT,
      "maxPlayers"  INTEGER,
      "players"     TEXT NOT NULL DEFAULT '[]',
      "spectators"  TEXT NOT NULL DEFAULT '[]',
      "battleState" TEXT,
      "inviteCode"  TEXT,
      "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "version"     INTEGER NOT NULL DEFAULT 0
    )
  `)

  await prisma.$executeRawUnsafe(`
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
    )
  `)

  // Add inviteCode column if it doesn't exist yet (safe migration)
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Room" ADD COLUMN "inviteCode" TEXT`)
  } catch { /* column already exists */ }

  console.log('[init-db] Tables created (or already exist).')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('[init-db] Error:', e.message)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
