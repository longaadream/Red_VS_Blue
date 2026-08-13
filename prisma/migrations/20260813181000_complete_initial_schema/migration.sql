ALTER TABLE "Room" ADD COLUMN "spectators" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "Room" ADD COLUMN "inviteCode" TEXT;

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
