/**
 * 数据迁移脚本：将所有 playerId 转换为小写
 * 运行方式：node scripts/migrate-player-ids.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

function migrateFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    let modified = false;

    // 迁移 players 数组中的 id
    if (data.players && Array.isArray(data.players)) {
      data.players.forEach(player => {
        if (player.id && typeof player.id === 'string') {
          const lowerId = player.id.toLowerCase();
          if (player.id !== lowerId) {
            console.log(`  Migrating player id: ${player.id} -> ${lowerId}`);
            player.id = lowerId;
            modified = true;
          }
        }
      });
    }

    // 迁移 hostId
    if (data.hostId && typeof data.hostId === 'string') {
      const lowerHostId = data.hostId.toLowerCase();
      if (data.hostId !== lowerHostId) {
        console.log(`  Migrating hostId: ${data.hostId} -> ${lowerHostId}`);
        data.hostId = lowerHostId;
        modified = true;
      }
    }

    // 迁移 battle 中的 playerId
    if (data.battle) {
      // 迁移 battle.players
      if (data.battle.players && Array.isArray(data.battle.players)) {
        data.battle.players.forEach(player => {
          if (player.playerId && typeof player.playerId === 'string') {
            const lowerId = player.playerId.toLowerCase();
            if (player.playerId !== lowerId) {
              console.log(`  Migrating battle playerId: ${player.playerId} -> ${lowerId}`);
              player.playerId = lowerId;
              modified = true;
            }
          }
        });
      }

      // 迁移 battle.turn.currentPlayerId
      if (data.battle.turn && data.battle.turn.currentPlayerId) {
        const lowerId = data.battle.turn.currentPlayerId.toLowerCase();
        if (data.battle.turn.currentPlayerId !== lowerId) {
          console.log(`  Migrating currentPlayerId: ${data.battle.turn.currentPlayerId} -> ${lowerId}`);
          data.battle.turn.currentPlayerId = lowerId;
          modified = true;
        }
      }

      // 迁移 battle.pieces 中的 ownerPlayerId
      if (data.battle.pieces && Array.isArray(data.battle.pieces)) {
        data.battle.pieces.forEach(piece => {
          if (piece.ownerPlayerId && typeof piece.ownerPlayerId === 'string') {
            const lowerId = piece.ownerPlayerId.toLowerCase();
            if (piece.ownerPlayerId !== lowerId) {
              console.log(`  Migrating piece ownerPlayerId: ${piece.ownerPlayerId} -> ${lowerId}`);
              piece.ownerPlayerId = lowerId;
              modified = true;
            }
          }
        });
      }

      // 迁移 battle.graveyard 中的 ownerPlayerId
      if (data.battle.graveyard && Array.isArray(data.battle.graveyard)) {
        data.battle.graveyard.forEach(piece => {
          if (piece.ownerPlayerId && typeof piece.ownerPlayerId === 'string') {
            const lowerId = piece.ownerPlayerId.toLowerCase();
            if (piece.ownerPlayerId !== lowerId) {
              console.log(`  Migrating graveyard piece ownerPlayerId: ${piece.ownerPlayerId} -> ${lowerId}`);
              piece.ownerPlayerId = lowerId;
              modified = true;
            }
          }
        });
      }

      // 迁移 battle.actions 中的 playerId
      if (data.battle.actions && Array.isArray(data.battle.actions)) {
        data.battle.actions.forEach(action => {
          if (action.playerId && typeof action.playerId === 'string') {
            const lowerId = action.playerId.toLowerCase();
            if (action.playerId !== lowerId) {
              console.log(`  Migrating action playerId: ${action.playerId} -> ${lowerId}`);
              action.playerId = lowerId;
              modified = true;
            }
          }
        });
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`  Saved: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`  Error processing ${filePath}:`, error.message);
    return false;
  }
}

function migrateDirectory(dirPath) {
  const files = fs.readdirSync(dirPath);
  let modifiedCount = 0;

  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      modifiedCount += migrateDirectory(filePath);
    } else if (file.endsWith('.json')) {
      console.log(`Processing: ${filePath}`);
      if (migrateFile(filePath)) {
        modifiedCount++;
      }
    }
  });

  return modifiedCount;
}

console.log('Starting playerId migration...\n');
const totalModified = migrateDirectory(DATA_DIR);
console.log(`\nMigration complete! Modified ${totalModified} files.`);
