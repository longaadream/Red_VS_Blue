const { readFileSync } = require('fs');
const { join } = require('path');

// 直接读取地图文件
const mapPath = join(__dirname, 'data', 'maps', 'arena-8x6.json');
const mapContent = readFileSync(mapPath, 'utf-8');
const mapConfig = JSON.parse(mapContent);

console.log('地图配置:', mapConfig);
console.log('布局:', mapConfig.layout);
console.log('图例:', mapConfig.legend);

// 测试创建地图
function createMapFromAscii(config) {
  const { id, name, layout, legend } = config;
  if (layout.length === 0) {
    throw new Error("layout must not be empty");
  }

  const width = layout[0].length;
  const height = layout.length;
  
  // 创建图例映射
  const legendDict = {};
  legend.forEach(entry => {
    legendDict[entry.char] = entry;
  });

  const tiles = [];

  layout.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error("all layout rows must have the same length");
    }

    Array.from(row).forEach((ch, x) => {
      const def = legendDict[ch];
      if (!def) {
        throw new Error(`no legend entry for character "${ch}"`);
      }

      tiles.push({
        id: `${id}-${x}-${y}`,
        x,
        y,
        props: {
          walkable: def.walkable,
          bulletPassable: def.bulletPassable,
          type: def.type,
          height: def.height,
          damagePerTurn: def.damagePerTurn,
        },
      });
    });
  });

  return { id, name, width, height, tiles };
}

try {
  const map = createMapFromAscii(mapConfig);
  console.log('创建的地图:', map);
  console.log('前10个格子:', map.tiles.slice(0, 10));
  
  // 统计不同类型的格子数量
  const typeCount = {};
  map.tiles.forEach(tile => {
    const type = tile.props.type;
    typeCount[type] = (typeCount[type] || 0) + 1;
  });
  console.log('格子类型统计:', typeCount);
} catch (error) {
  console.error('创建地图时出错:', error);
}
