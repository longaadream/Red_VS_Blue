# SkillCode 快速入门

这是一份给内容作者的短入口。完整的现役接口、pending 重放、伤害管线、触发顺序、安全边界和范例，请阅读 [SkillCode 作者标准与现役 Helper 接口手册](./technical/SKILLCODE_AUTHORING_STANDARD.md)。

> 安全提醒：当前 SkillCode 不是沙箱，只允许执行随项目审查和发布的受信任代码。不要导入或运行来源不明的玩家代码；外部内容执行能力要等 RED-135 的受限 Runtime 和权限体系完成。

## 五步写一个技能

1. 写清楚技能要选择什么、消耗什么、造成什么结果，以及取消时如何处理。
2. 在技能 JSON 的 `targeting.steps` 中按顺序声明选项和目标。
3. 在 `code` 中以相同顺序调用 `selectOption` 和 `selectTarget`。
4. 用 `dealDamage`、`healDamage`、状态、手牌、规则和空间 Helper 改变战局，不直接修改底层字段或数组。
5. 运行兼容审计，并验证正常、取消、目标失效、重连和确定性回放。

## 最小安全示例

```js
const target = selectTarget({
  type: 'piece',
  range: 3,
  filter: 'enemy'
});

// 缺少权威答案时，立即返回，让服务端建立 pending。
if (target?.needsTargetSelection) return target;

if (!target || target.currentHp <= 0) {
  return { success: false, message: '目标已经失效' };
}

// 不要直接写 target.currentHp -= 4。
dealDamage(sourcePiece, target, 4, 'physical');
return { success: true, message: '造成4点物理伤害' };
```

相应的目标声明至少应包含：

```json
{
  "targeting": {
    "steps": [
      { "kind": "target", "type": "piece", "range": 3, "filter": "enemy" }
    ]
  }
}
```

## 必须避免

- 不要直接改 `currentHp`、坐标、手牌、规则、状态或技能数组；
- 不要在伤害触发器中再次直接调用 `dealDamage`，使用 `damageQueue`；
- 不要把对象或函数放进 pending payload，只保存 ID、坐标、数值和枚举；
- 不要用系统时间、宿主随机数、文件、网络或进程 API；
- 不要把 `previewCode` 的结果当成权威结算；
- 不要假设技能、卡牌、规则和触发器拥有完全相同的 Helper。

## 提交前命令

```bash
node scripts/audit-skillcode-compat.mjs
npm.cmd run check:encoding
```

作者遇到“点击选项没反应”“重连后 pending 卡死”或“两端 authorityVersion 不一致”时，不要反复点击掩盖问题；保留随机种子、动作 ID、pending consumer/cursor、回合阶段、authorityVersion 和服务端拒绝原因，再按完整手册排查。
