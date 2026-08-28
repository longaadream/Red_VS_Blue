import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

function initializeDatabase(databasePath: string): string {
  return execFileSync(
    process.execPath,
    [
      resolve('scripts/init-db.js'),
      `file:${databasePath.replaceAll('\\', '/')}`,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
}

function createTemporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rvb-red125-client-db-'))
  temporaryDirectories.push(directory)
  return join(directory, 'game.db')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('packaged client database initialization', () => {
  it('does not require a standalone Prisma module directory before initialization', () => {
    const electronMain = readFileSync(resolve('electron-client/main.ts'), 'utf8')
    const initializer = readFileSync(resolve('scripts/init-db.js'), 'utf8')

    expect(electronMain).toContain('execFileSync(')
    expect(electronMain).toContain("[initScript, 'file:' + dbPath]")
    expect(electronMain).not.toContain('findStandaloneModules')
    expect(electronMain).not.toContain('skipping DB init')
    expect(initializer).toContain("require('node:sqlite')")
    expect(initializer).not.toContain("require(path.join(moduleRoot, '.prisma', 'client'))")
  })

  it('creates the current Room authority columns, persistence tables, and indexes', () => {
    const databasePath = createTemporaryDatabase()
    expect(initializeDatabase(databasePath)).toContain('Tables created')

    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const roomColumns = database
        .prepare('PRAGMA table_info("Room")')
        .all()
        .map((row) => String(row.name))
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name))
      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => String(row.name))

      expect(roomColumns).toEqual(expect.arrayContaining([
        'battleAuthorityVersion',
        'battleAuthorityTransitionHash',
      ]))
      expect(tables).toEqual(expect.arrayContaining([
        'BattleAuthorityTransition',
        'BattleAuthorityReceipt',
        'BattleAuthorityCheckpoint',
      ]))
      expect(indexes).toEqual(expect.arrayContaining([
        'BattleAuthorityTransition_roomId_clientActionId_key',
        'BattleAuthorityTransition_roomId_fromVersion_idx',
        'BattleAuthorityReceipt_roomId_authorityVersion_idx',
        'BattleAuthorityCheckpoint_roomId_createdAt_idx',
      ]))
    } finally {
      database.close()
    }
  })

  it('can be run repeatedly without duplicating or dropping initialized structures', () => {
    const databasePath = createTemporaryDatabase()
    initializeDatabase(databasePath)
    initializeDatabase(databasePath)

    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const authorityTables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'BattleAuthority%'")
        .all()
        .map((row) => String(row.name))
      expect(authorityTables).toHaveLength(3)
      expect(new Set(authorityTables).size).toBe(3)
    } finally {
      database.close()
    }
  })

  it('repairs the incomplete Room schema created by the previous packaged client', () => {
    const databasePath = createTemporaryDatabase()
    const legacyDatabase = new DatabaseSync(databasePath)
    try {
      legacyDatabase.exec(`
        CREATE TABLE "Room" (
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
    } finally {
      legacyDatabase.close()
    }

    initializeDatabase(databasePath)

    const repairedDatabase = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const roomColumns = repairedDatabase
        .prepare('PRAGMA table_info("Room")')
        .all()
        .map((row) => String(row.name))
      expect(roomColumns).toEqual(expect.arrayContaining([
        'battleAuthorityVersion',
        'battleAuthorityTransitionHash',
      ]))
    } finally {
      repairedDatabase.close()
    }
  })
})
