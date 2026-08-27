-- Baseline the schema that existed before RED-119 introduced Room.mapId.
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "players" JSONB NOT NULL DEFAULT '[]',
    "inviteCode" TEXT,
    "lastStateBlob" TEXT,
    "actionLog" JSONB NOT NULL DEFAULT '[]',
    "hostDisconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaderboardPlayer" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardPlayer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BattleRecord" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "actionLog" JSONB NOT NULL,
    "hostSignature" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BattleRecord_pkey" PRIMARY KEY ("id")
);

-- Room.mapId intentionally does not exist in this baseline. The following
-- 20260827102000_add_room_map_id migration adds it as nullable with no backfill.
