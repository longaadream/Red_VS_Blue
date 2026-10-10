'use strict'

/*
 * Isolated production action-history layout fixture for RED250.
 *
 * This intentionally loads the real tabletop CSS and action-history renderer,
 * but does not start the live game. The fixture model contains
 * one representative root action with three fixture effect events and a two-level
 * response cause path.  The checks are geometry assertions: a long title or
 * response branch must not push an effect row or its amount badge outside the
 * rendered history card.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'docs/qa/RED250')

function createModel() {
  const responsePath = [
    {
      id: 'response-outer',
      sourcePieceId: 'aizen',
      skillId: 'kyoka-suigetsu-response',
      label: '镜花水月·超长响应标题·验证深层布局宽度',
    },
    {
      id: 'response-inner',
      sourcePieceId: 'ulqiorra',
      skillId: 'segunda-etapa-response',
      label: '第二阶段·再次响应标题·验证嵌套分支不挤出卡片',
    },
  ]

  return {
    board: { width: 8, height: 6 },
    pieces: [
      { id: 'turalyon', name: '图拉杨·圣光守望者·超长名称测试', faction: 'blue', x: 1, y: 1, alive: true },
      { id: 'ulqiorra', name: '乌尔奇奥拉·第二阶段·响应目标', faction: 'red', x: 5, y: 3, alive: true },
      { id: 'aizen', name: '蓝染惣右介·镜花水月·深层响应', faction: 'red', x: 6, y: 4, alive: true },
      { id: 'ichigo', name: '黑崎一护·卍解·备用棋子名称', faction: 'blue', x: 2, y: 4, alive: true },
    ],
    players: [
      { id: 'player-blue', name: '蓝方玩家·超长名称', faction: 'blue' },
      { id: 'player-red', name: '红方玩家·超长名称', faction: 'red' },
    ],
    turn: { number: 2, phase: 'main', activePlayerId: 'player-blue' },
    selection: { mode: 'idle' },
    skillSummariesById: {
      'holy-smite': {
        id: 'holy-smite',
        name: '圣铸进军·神圣惩戒·超长技能标题布局测试',
      },
    },
    presentationEvents: [
      {
        eventId: 'holy-root',
        rootEventId: 'holy-root',
        actionId: 'holy-root',
        sequence: 0,
        kind: 'skill',
        skillId: 'holy-smite',
        label: '圣铸进军·神圣惩戒·超长技能标题布局测试',
        sourcePieceId: 'turalyon',
        actorPlayerId: 'player-blue',
        targetCell: { x: 5, y: 3 },
        result: { pending: true },
      },
      {
        eventId: 'holy-damage',
        rootEventId: 'holy-root',
        parentEventId: 'holy-root',
        actionId: 'holy-root',
        sequence: 1,
        kind: 'damage',
        iconId: 'action-damage',
        sourcePieceId: 'turalyon',
        targetPieceIds: ['ulqiorra'],
        result: { amount: 987654 },
        causePath: responsePath,
      },
      {
        eventId: 'holy-heal',
        rootEventId: 'holy-root',
        parentEventId: 'holy-root',
        actionId: 'holy-root',
        sequence: 2,
        kind: 'heal',
        iconId: 'action-heal',
        sourcePieceId: 'turalyon',
        targetPieceIds: ['turalyon'],
        result: { amount: 123456 },
        causePath: responsePath,
      },
      {
        eventId: 'holy-status',
        rootEventId: 'holy-root',
        parentEventId: 'holy-root',
        actionId: 'holy-root',
        sequence: 3,
        kind: 'statusAdded',
        iconId: 'status-add',
        sourcePieceId: 'aizen',
        targetPieceIds: ['ulqiorra'],
        statusType: 'divine-shield',
        complement: {
          kind: 'status',
          type: 'divine-shield',
          label: '圣盾·深层响应状态',
        },
        result: { stacks: 7777 },
        causePath: responsePath,
      },
    ],
  }
}

function productionStyles(page) {
  return [...page.matchAll(/<style[^>]*>[\s\S]*?<\/style>|<link[^>]*rel=["']stylesheet["'][^>]*>/gi)]
    .map(([tag]) => {
      if (tag.startsWith('<style')) return tag
      const href = tag.match(/href=["']([^"']+)/i)?.[1]
      if (!href || /^(https?:)?\/\//i.test(href)) return ''
      return `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'data/pages', href)).href}">`
    })
    .join('\n')
}

function fixtureHtml(page) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + productionStyles(page)
    + `<style id="red250-history-fixture-style">
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { position: relative; display: block; min-width: 0; }
      #red250-history-board { position: fixed; inset: 0; background: rgba(39, 31, 22, .16); }
    </style></head><body class="red250-history-fixture">
      <div id="red250-history-board" aria-hidden="true"></div>
      <aside id="actionHistoryDock" class="action-history-dock" data-battle-ui-region="action-history" aria-label="最近动作" hidden></aside>
    </body></html>`
}

function checkGeometry() {
  const rectOf = element => {
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return {
      left: Number(rect.left.toFixed(2)),
      right: Number(rect.right.toFixed(2)),
      top: Number(rect.top.toFixed(2)),
      bottom: Number(rect.bottom.toFixed(2)),
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2)),
    }
  }
  const dock = document.getElementById('actionHistoryDock')
  const list = dock && dock.querySelector('.action-history-list')
  const item = list && list.querySelector('.action-history-item')
  const allRows = item ? [...item.querySelectorAll('.action-history-sentence')] : []
  const effectRows = allRows.filter(row => !row.classList.contains('is-root'))
  const itemRect = rectOf(item)
  const dockRect = rectOf(dock)

  const rows = allRows.map(row => {
    const rowRect = rectOf(row)
    const amount = row.querySelector('.action-history-complement.is-amount')
    const amountRect = rectOf(amount)
    const children = [...row.children].map(child => ({ element: child, rect: rectOf(child) }))
    const amountOverlaps = amountRect
      ? children.filter(child => child.element !== amount && child.rect
        && child.rect.bottom > amountRect.top + 0.5 && child.rect.top < amountRect.bottom - 0.5
        && child.rect.right > amountRect.left + 0.5 && child.rect.left < amountRect.right - 0.5)
        .map(child => child.element.className)
      : []
    return {
      eventId: row.dataset.historyEventId,
      rect: rowRect,
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      amount: amountRect ? {
        text: amount.textContent.trim(),
        rect: amountRect,
        withinRow: !!rowRect && amountRect.left >= rowRect.left - 1 && amountRect.right <= rowRect.right + 1,
        overlaps: amountOverlaps,
      } : null,
      children: children.map(child => {
        const style = getComputedStyle(child.element)
        return {
          className: child.element.className,
          text: child.element.textContent.trim(),
          rect: child.rect,
          minWidth: style.minWidth,
          flexShrink: style.flexShrink,
          overflowX: style.overflowX,
          whiteSpace: style.whiteSpace,
        }
      }),
      withinItem: !!rowRect && !!itemRect && rowRect.left >= itemRect.left - 1 && rowRect.right <= itemRect.right + 1,
    }
  })

  const responses = item ? [...item.querySelectorAll('.history-response')].map(response => ({
    rect: rectOf(response),
    title: rectOf(response.querySelector('.history-response-title')),
    titleScrollWidth: response.querySelector('.history-response-title')?.scrollWidth || 0,
    titleClientWidth: response.querySelector('.history-response-title')?.clientWidth || 0,
  })) : []

  const violations = []
  if (!dock || !item) violations.push('missing rendered action-history item')
  if (effectRows.length !== 3) violations.push(`expected 3 rendered effect rows, got ${effectRows.length}`)
  for (const row of rows) {
    if (!row.withinItem) violations.push(`${row.eventId}: row extends outside item bounds`)
    if (row.scrollWidth > row.clientWidth + 1) violations.push(`${row.eventId}: row scrollWidth ${row.scrollWidth} > clientWidth ${row.clientWidth}`)
    if (row.amount && !row.amount.withinRow) violations.push(`${row.eventId}: amount badge extends outside row bounds`)
    if (row.amount && row.amount.overlaps.length) violations.push(`${row.eventId}: amount badge overlaps ${row.amount.overlaps.join(', ')}`)
  }
  if (item && item.scrollWidth > item.clientWidth + 1) violations.push(`item scrollWidth ${item.scrollWidth} > clientWidth ${item.clientWidth}`)
  for (const [index, response] of responses.entries()) {
    if (response.titleScrollWidth > response.titleClientWidth + 1) violations.push(`response ${index}: title scrollWidth ${response.titleScrollWidth} > clientWidth ${response.titleClientWidth}`)
  }

  return {
    viewport: { width: innerWidth, height: innerHeight },
    expanded: dock?.classList.contains('is-user-expanded') || false,
    collapseReason: dock?.dataset.collapseReason || '',
    dock: dockRect,
    item: itemRect ? { ...itemRect, clientWidth: item.clientWidth, scrollWidth: item.scrollWidth } : null,
    list: list ? { rect: rectOf(list), clientWidth: list.clientWidth, scrollWidth: list.scrollWidth, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight } : null,
    effectRowCount: effectRows.length,
    rows,
    responses,
    violations,
  }
}

async function main() {
  const { app, BrowserWindow, session } = require('electron')
  app.disableHardwareAcceleration()
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red250-history-layout-')))
  fs.mkdirSync(output, { recursive: true })

  const page = fs.readFileSync(path.join(root, 'data/pages/battle.html'), 'utf8')
  const fixture = path.join(root, 'dist/red250-history-layout-fixture.html')
  fs.mkdirSync(path.dirname(fixture), { recursive: true })
  fs.writeFileSync(fixture, fixtureHtml(page))

  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }))
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const results = []
  const modelSource = JSON.stringify(createModel())
  let exitCode = 0

  try {
    for (const [width, height] of [[1280, 720], [844, 390]]) {
      win.setContentSize(width, height)
      await win.loadFile(fixture)
      for (const [name, source] of [
        ['battle-effect-icons', fs.readFileSync(path.join(root, 'data/pages/js/battle-ui/battle-effect-icons.js'), 'utf8')],
        ['battle-action-identity', fs.readFileSync(path.join(root, 'data/pages/js/battle-ui/battle-action-identity.js'), 'utf8')],
        ['battle-action-history', fs.readFileSync(path.join(root, 'data/pages/js/battle-ui/battle-action-history.js'), 'utf8')],
      ]) {
        try { await win.webContents.executeJavaScript(source) } catch (error) { throw new Error(`${name} injection failed: ${error.message}`) }
      }
      await win.webContents.executeJavaScript(`(() => {
        window.__red250HistoryModel = ${modelSource};
        window.__red250HistoryUi = BattleActionHistory.create();
        window.__red250HistoryUi.mount({ element: document.getElementById('actionHistoryDock') });
        window.__red250HistoryUi.update(window.__red250HistoryModel);
        const button = document.querySelector('.action-history-collapsed-button');
        if (button) button.click();
      })()`)
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')

      const record = await win.webContents.executeJavaScript(`(${checkGeometry.toString()})()`)
      record.source = 'production tabletop CSS + BattleEffectIcons + BattleActionIdentity + BattleActionHistory'
      record.modelEffectEventIds = ['holy-damage', 'holy-heal', 'holy-status']
      results.push(record)
      fs.writeFileSync(path.join(output, `history-layout-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG())
    }

    const report = {
      fixture: true,
      notHumanAcceptance: true,
      model: 'representative skill root, three fixture effect events, two-level causePath response',
      layoutSource: 'data/pages/css/battle-context-ui.css',
      results,
    }
    fs.writeFileSync(path.join(output, 'history-layout-geometry.json'), JSON.stringify(report, null, 2) + '\n')
    const failures = results.flatMap(result => result.violations.map(violation => `${result.viewport.width}x${result.viewport.height}: ${violation}`))
    if (failures.length) {
      console.error('RED250 history layout violations')
      failures.forEach(failure => console.error(`- ${failure}`))
      exitCode = 1
    }
    console.log(JSON.stringify({ viewports: results.length, effectRows: results.map(result => result.effectRowCount), failures }))
  } finally {
    win.destroy()
    app.exit(exitCode)
  }
}

if (process.versions.electron) {
  main().catch(error => {
    console.error(error)
    require('electron').app.exit(1)
  })
} else {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = require('electron')
  const child = spawn(electron, [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}
