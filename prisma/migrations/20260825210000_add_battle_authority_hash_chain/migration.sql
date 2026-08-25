ALTER TABLE "Room"
ADD COLUMN "battleAuthorityTransitionHash" TEXT NOT NULL DEFAULT '';

ALTER TABLE "BattleAuthorityTransition"
ADD COLUMN "actionHash" TEXT NOT NULL DEFAULT '';

ALTER TABLE "BattleAuthorityTransition"
ADD COLUMN "previousTransitionHash" TEXT NOT NULL DEFAULT '';

ALTER TABLE "BattleAuthorityTransition"
ADD COLUMN "transitionHash" TEXT NOT NULL DEFAULT '';

ALTER TABLE "BattleAuthorityCheckpoint"
ADD COLUMN "transitionHash" TEXT NOT NULL DEFAULT '';
