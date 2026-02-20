// 状态系统测试脚本
const { statusEffectSystem, predefinedStatusEffects, StatusEffectType } = require('./lib/game/status-effects');

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
console.log('=== 状态系统测试 ===');

// 测试1: 添加流血状态
console.log('\n1. 测试添加流血状态');
const bleedingEffect = predefinedStatusEffects.bleeding(3, 5);
const addedBleeding = statusEffectSystem.addStatusEffect(mockPiece.instanceId, bleedingEffect);
console.log('添加的流血状态:', addedBleeding);

// 测试2: 查看棋子的状态效果
console.log('\n2. 查看棋子的状态效果');
const statusEffects = statusEffectSystem.getStatusEffects(mockPiece.instanceId);
console.log('棋子的状态效果:', statusEffects);

// 测试3: 检查棋子是否有流血状态
console.log('\n3. 检查棋子是否有流血状态');
const hasBleeding = statusEffectSystem.hasStatusEffect(mockPiece.instanceId, StatusEffectType.BLEEDING);
console.log('棋子有流血状态:', hasBleeding);

// 测试4: 模拟回合更新
console.log('\n4. 模拟回合更新');
console.log('更新前棋子生命值:', mockPiece.currentHp);

// 模拟状态系统的getPieceById方法返回mockPiece
statusEffectSystem.getPieceById = () => mockPiece;

// 更新状态效果
statusEffectSystem.updateStatusEffects();
console.log('更新后棋子生命值:', mockPiece.currentHp);

// 测试5: 添加多个状态效果
console.log('\n5. 测试添加多个状态效果');
const poisonEffect = predefinedStatusEffects.poison(4, 3);
statusEffectSystem.addStatusEffect(mockPiece.instanceId, poisonEffect);
const buffEffect = predefinedStatusEffects.buffAttack(3, 2);
statusEffectSystem.addStatusEffect(mockPiece.instanceId, buffEffect);

const updatedStatusEffects = statusEffectSystem.getStatusEffects(mockPiece.instanceId);
console.log('添加多个状态效果后:', updatedStatusEffects);
console.log('更新后棋子攻击力:', mockPiece.attack);

// 测试6: 测试状态叠加
console.log('\n6. 测试状态叠加');
const secondBleedingEffect = predefinedStatusEffects.bleeding(3, 5);
const stackedBleeding = statusEffectSystem.addStatusEffect(mockPiece.instanceId, secondBleedingEffect);
console.log('叠加后的流血状态:', stackedBleeding);

// 测试7: 移除状态效果
console.log('\n7. 测试移除状态效果');
const removeResult = statusEffectSystem.removeStatusEffect(mockPiece.instanceId, addedBleeding.id);
console.log('移除状态效果结果:', removeResult);

const afterRemoveEffects = statusEffectSystem.getStatusEffects(mockPiece.instanceId);
console.log('移除后剩余的状态效果:', afterRemoveEffects);

// 测试8: 移除所有状态效果
console.log('\n8. 测试移除所有状态效果');
statusEffectSystem.removeAllStatusEffects(mockPiece.instanceId);
const finalEffects = statusEffectSystem.getStatusEffects(mockPiece.instanceId);
console.log('移除所有状态效果后:', finalEffects);
console.log('最终棋子攻击力:', mockPiece.attack);

console.log('\n=== 状态系统测试完成 ===');
