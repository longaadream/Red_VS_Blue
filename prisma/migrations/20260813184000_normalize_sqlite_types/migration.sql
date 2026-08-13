-- Normalize the legacy TIMESTAMP(3) declarations to SQLite DATETIME so the
-- committed migration history produces the same schema as schema.prisma.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Room" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "mapId" TEXT,
    "hostId" TEXT,
    "visibility" TEXT,
    "maxPlayers" INTEGER,
    "players" TEXT NOT NULL DEFAULT '[]',
    "spectators" TEXT NOT NULL DEFAULT '[]',
    "battleState" TEXT,
    "inviteCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_Room" ("battleState", "createdAt", "hostId", "id", "inviteCode", "mapId", "maxPlayers", "name", "players", "spectators", "status", "updatedAt", "version", "visibility")
SELECT "battleState", "createdAt", "hostId", "id", "inviteCode", "mapId", "maxPlayers", "name", "players", "spectators", "status", "updatedAt", "version", "visibility" FROM "Room";
DROP TABLE "Room";
ALTER TABLE "new_Room" RENAME TO "Room";

CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "id", "passwordHash", "username")
SELECT "createdAt", "id", "passwordHash", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
