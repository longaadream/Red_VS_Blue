CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "username" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Room" (
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
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "GameRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
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
);
