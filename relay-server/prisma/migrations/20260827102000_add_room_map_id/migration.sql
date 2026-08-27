-- Preserve legacy rooms as NULL; newly created rooms are validated in the lobby route.
ALTER TABLE "Room" ADD COLUMN "mapId" TEXT;
