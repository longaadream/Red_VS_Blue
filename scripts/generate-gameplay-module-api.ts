/** Generate the implemented API from the exact catalog consumed by the editor. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getGameplayModuleCatalog } from '../lib/skill-graph/module-registry'
import { AUTHOR_MODULE_CATEGORIES } from '../lib/skill-graph/author-module-catalog'

const escape = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const format = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value)
type Field = { name: string; label?: string; type: unknown; description?: string; nullable?: boolean; optional?: boolean; default?: unknown; enum?: readonly unknown[]; minimum?: number; maximum?: number }
const portTable = (ports: readonly Field[], parameter = false) => ports.length ? [
  '| 名称 | 含义 | 类型 | 必填 | ' + (parameter ? '默认值 / 可选值' : '说明') + ' |',
  '| --- | --- | --- | --- | --- |',
  ...ports.map(port => `| \`${escape(port.name)}\` | ${escape(port.label || port.name)} | \`${escape(format(port.type))}\`${port.nullable ? '（可空）' : ''} | ${port.optional ? '否' : '是'} | ${escape([
    port.description,
    Object.hasOwn(port, 'default') ? '默认 ' + format(port.default) : undefined,
    port.enum ? port.enum.map(format).join(' / ') : undefined,
    port.minimum !== undefined ? '最小 ' + port.minimum : undefined,
    port.maximum !== undefined ? '最大 ' + port.maximum : undefined,
  ].filter(Boolean).join('；'))} |`),
].join('\n') : '无。'

export function gameplayModuleApiMarkdown(): string {
  const catalog = getGameplayModuleCatalog().filter(item => item.ui?.authoring === 'standard')
  const groups = new Map<string, typeof catalog[number][]>()
  for (const item of catalog) {
    const key = item.ui?.category || item.id.split('.')[0]
    const category = AUTHOR_MODULE_CATEGORIES[key as keyof typeof AUTHOR_MODULE_CATEGORIES] || key
    groups.set(category, [...(groups.get(category) || []), item])
  }
  const lines = [
    '# 作者原子模块接口', '',
    '由 `scripts/generate-gameplay-module-api.ts` 从工作台实际注册目录生成。修改接口后重新生成，不在本文另行维护一套参数。', '',
    `当前提供 **${catalog.length}** 个原子接口。此数量不包括旧资源内部适配器，不表示游戏内容、编辑器操作或运行行为已全部验收。`, '',
    '工作台只提供通用原子语句和流程结构。旧内容适配器仅供内部读取与诊断，不出现在新增语句或表达式目录中，包括高级选项。', '',
    'extension 列表只建议当前上下文已声明的变量；也可以自定义指定对象、路径与类型。自定义访问不创建变量；字段缺失时该语句及其依赖语句无效，独立后续继续，无需编写 fallback。', '',
    '在效果编辑区选择“添加效果”或表达式模块，再连接下表的输入；参数为编辑时确定的值，输入可以连接其他模块的输出。组合模块、记录、循环和续接属于结构语句，见[工作台说明](WORKBENCH_UI_GUIDE.md)与[语句手册](AUTHOR_STATEMENT_MANUAL.md)。', '',
    '技能与卡牌的实例、棋子、玩家等引用必须来自前序模块或入口，不需要手填内部 ID。允许入口是实际编译器约束；例如预览中不能调用有战斗副作用的模块。', '',
    '| 分类 | 已登记模块数 |', '| --- | ---: |',
    ...[...groups].map(([category, items]) => `| ${escape(category)} | ${items.length} |`), '',
  ]
  for (const [category, items] of groups) {
    lines.push(`## ${escape(category)}`, '')
    for (const item of items) {
      lines.push(`### ${item.label || item.id}`, '', `接口：\`${item.id}@${item.version}\`。`, '',
        `作者目录：${item.ui?.authoring === 'standard' ? '原子语句' : '旧资源内部适配（不可添加）'}。`, '',
        escape(item.description || item.uiDescription || '通过下面声明的类型端口调用宿主能力。'), '',
        `允许入口：${item.allowedSurfaces.join('、')}。`, '', '**输入**', '',
        portTable(item.inputs as readonly Field[]), '', '**参数**', '',
        portTable((item.parameters || []) as readonly Field[], true), '', '**输出**', '',
        portTable(item.outputs as readonly Field[]), '')
      if (item.outputTypeBindings) lines.push(`输出类型推导：\`${escape(JSON.stringify(item.outputTypeBindings))}\`。`, '')
      if (item.outputSchemaBindings || item.inputSchemaBindings) lines.push(`记录类型由参数选择的结构声明确定：\`${escape(JSON.stringify({ inputs: item.inputSchemaBindings, outputs: item.outputSchemaBindings }))}\`。`, '')
      if (item.outputValueTypeBindings || item.inputValueTypeBindings) lines.push(`值类型由类型选择器确定（表中的 record 是注册表占位类型）：\`${escape(JSON.stringify({ inputs: item.inputValueTypeBindings, outputs: item.outputValueTypeBindings }))}\`。`, '')
      if (item.outputParameterTypeBindings) {
        lines.push('选择字段后，输出类型随之变化：', '', '| 字段 | 输出类型 |', '| --- | --- |')
        for (const binding of Object.values(item.outputParameterTypeBindings)) {
          for (const [field, type] of Object.entries(binding.types)) lines.push(`| \`${escape(field)}\` | \`${escape(format(type))}\` |`)
        }
        lines.push('')
      }
      lines.push(`执行声明：${escape([
        item.effects.description,
        item.effects.pure ? '纯计算' : undefined,
        item.effects.previewSafe ? '可预览' : undefined,
        item.effects.reads?.length ? '读取 ' + item.effects.reads.join('、') : undefined,
        item.effects.writes?.length ? '写入 ' + item.effects.writes.join('、') : undefined,
        item.effects.random ? '使用种子随机流' : undefined,
        item.effects.pending ? '可能等待玩家选择' : undefined,
        item.effects.events?.length ? '事件 ' + item.effects.events.join('、') : undefined,
      ].filter(Boolean).join('；')) || '无额外声明'}。`, '')
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL('../docs/technical/GAMEPLAY_MODULE_API.md', import.meta.url))
  fs.writeFileSync(file, gameplayModuleApiMarkdown(), 'utf8')
  console.log(path.relative(process.cwd(), file))
}
