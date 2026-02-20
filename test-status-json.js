// 测试从JSON文件加载状态定义
const { statusEffectSystem, StatusEffectType } = require('./lib/game/status-effects');

// 模拟棋子对象
const mockPiece = {
  instanceId: 'test-piece-1',
  templateId: 'test-warrior',
  ownerPlayerId: 'player-1',
  currentHp: 100,
  maxHp: 100,
  attack: 20,
  defense: 10,
  x: 5,
  y: 5,
  moveRange: 2
};

// 测试状态系统
console.log('=== 状态系统JSON测试 ===');

// 测试1: 加载状态定义
console.log('\n1. 测试加载流血状态定义');
const bleedingDefinition = statusEffectSystem.loadStatusDefinitionFromFile('./data/status-effects/bleeding.json');
console.log('加载的状态定义:', bleedingDefinition);

// 测试2: 从定义创建状态效果
console.log('\n2. 测试从定义创建状态效果');
const bleedingEffect = statusEffectSystem.createStatusEffectFromDefinition(bleedingDefinition);
console.log('创建的状态效果:', bleedingEffect);

// 测试3: 添加状态效果到棋子
console.log('\n3. 测试添加状态效果到棋子');
const addedEffect = statusEffectSystem.addStatusEffect(mockPiece.instanceId, bleedingEffect);
console.log('添加的状态效果:', addedEffect);

// 测试4: 查看棋子的状态效果
console.log('\n4. 查看棋子的状态效果');
const statusEffects = statusEffectSystem.getStatusEffects(mockPiece.instanceId);
console.log('棋子的状态效果:', statusEffects);

// 测试5: 模拟回合更新
console.log('\n5. 模拟回合更新');
console.log('更新前棋子生命值:', mockPiece.currentHp);

// 模拟状态系统的getPieceById方法返回mockPiece
statusEffectSystem.getPieceById = () => mockPiece;

// 更新状态效果
statusEffectSystem.updateStatusEffects();
console.log('更新后棋子生命值:', mockPiece.currentHp);

// 测试6: 通过ID添加状态效果
console.log('\n6. 测试通过ID添加状态效果');
const addedById = statusEffectSystem.addStatusEffectById(mockPiece.instanceId, 'bleeding');
console.log('通过ID添加的状态效果:', addedById);

console.log('\n=== 状态系统JSON测试完成 ===');
