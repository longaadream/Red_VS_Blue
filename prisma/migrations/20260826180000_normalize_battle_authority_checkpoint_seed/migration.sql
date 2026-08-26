UPDATE "BattleAuthorityCheckpoint"
SET "seed" = "seed" - 4294967296
WHERE "seed" BETWEEN 2147483648 AND 4294967295;
