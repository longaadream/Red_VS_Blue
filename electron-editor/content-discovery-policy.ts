/**
 * Packaged definitions that deliberately do not participate in discovery.
 * Armor templates are materialized by content.materialize-template; the
 * archived skill remains readable by older authored graphs. Neither family
 * may be added to ordinary manifests just to satisfy workbench validation.
 * Unknown unregistered definitions still fail validation.
 */
const NON_DISCOVERY_DEFINITIONS = new Map<string, string>([
  ...[
    'armor-attack-defense', 'armor-attack-heal', 'armor-attack-speed',
    'armor-defense-heal', 'armor-defense-speed', 'armor-heal-speed',
  ].map(id => [`data/cards/${id}.json`, '生成护甲模板：由运行时实例化，不进入普通卡牌目录'] as const),
  ['data/skills/grimmjow-gran-rey-cero.json', '历史技能定义：保留兼容读取，不进入普通技能目录'],
  ['data/rules/rule-lucky-coin-gamestart.json', '系统规则：由对局初始化直接加载'],
])

export function nonDiscoveryDefinitionReason(relative: string): string | undefined {
  return NON_DISCOVERY_DEFINITIONS.get(relative)
}
