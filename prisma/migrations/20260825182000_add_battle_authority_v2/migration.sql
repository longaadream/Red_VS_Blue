ALTER TABLE "Room" ADD COLUMN "battleAuthorityVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "BattleAuthorityTransition" (
    "roomId" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "clientActionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "commandJson" TEXT NOT NULL,
    "internalPatch" TEXT NOT NULL,
    "publicPatch" TEXT NOT NULL,
    "preStateHash" TEXT NOT NULL,
    "postStateHash" TEXT NOT NULL,
    "prePublicHash" TEXT NOT NULL,
    "postPublicHash" TEXT NOT NULL,
    "pendingJson" TEXT,
    "traceJson" TEXT,
    "replayFrameJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("roomId", "toVersion")
);

CREATE TABLE "BattleAuthorityReceipt" (
    "roomId" TEXT NOT NULL,
    "clientActionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "authorityVersion" INTEGER NOT NULL,
    "code" TEXT,
    "message" TEXT,
    "receiptJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("roomId", "clientActionId")
);

CREATE TABLE "BattleAuthorityCheckpoint" (
    "roomId" TEXT NOT NULL,
    "authorityVersion" INTEGER NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "stateJson" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "publicHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("roomId", "authorityVersion")
);

CREATE UNIQUE INDEX "BattleAuthorityTransition_roomId_clientActionId_key"
ON "BattleAuthorityTransition"("roomId", "clientActionId");

CREATE INDEX "BattleAuthorityTransition_roomId_fromVersion_idx"
ON "BattleAuthorityTransition"("roomId", "fromVersion");

CREATE INDEX "BattleAuthorityReceipt_roomId_authorityVersion_idx"
ON "BattleAuthorityReceipt"("roomId", "authorityVersion");

CREATE INDEX "BattleAuthorityCheckpoint_roomId_createdAt_idx"
ON "BattleAuthorityCheckpoint"("roomId", "createdAt");
