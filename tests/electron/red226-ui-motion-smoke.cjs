'use strict'

/* RED-226 candidate smoke: exercise the shared page layer through Electron. */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const pagesRoot = path.join(root, 'data', 'pages')
const port = Number(process.env.RVB_RED226_PORT || 38726)
const baseUrl = `http://127.0.0.1:${port}`
const evidenceRoot = path.resolve(process.env.RVB_RED226_EVIDENCE_ROOT || path.join(root, 'output', 'RED226'))
const routePages = [
  { id: 'index', file: 'index.html', selectors: ['#tutorialShortcut', '.mode-tab', 'button', 'a[href]'] },
  { id: 'pieces', file: 'pieces.html', selectors: ['#pieceGrid > .piece-card', '.piece-card', 'button', 'a[href]'] },
  { id: 'piece-selection', file: 'piece-selection.html', selectors: ['.piece-choice', '#pieceGrid > .piece-card', 'button', 'a[href]'] },
  { id: 'room', file: 'room.html', selectors: ['.room-row', '.room-card', 'button', 'a[href]'] },
  { id: 'maps', file: 'maps.html', selectors: ['.map-card', '.ranked-map-card', 'button', 'a[href]'] },
  { id: 'battle', file: 'battle.html', selectors: ['#handCards > .card-item', '.action-button', 'button', 'a[href]'] },
]
const mobileSizes = [[844, 390], [390, 844]]

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const ensure = (condition, message) => { if (!condition) throw new Error(message) }

function stopProcessTree(pid) {
  if (!Number.isInteger(pid)) return
  if (process.platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 10000 }) } catch {}
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`preview did not start at ${url}: ${lastError || 'timeout'}`)
}

function inspectAnimation(animation) {
  let keyframes = []
  try { keyframes = animation.effect?.getKeyframes?.() || [] } catch {}
  return {
    playState: animation.playState,
    currentTime: animation.currentTime,
    composite: keyframes.map(frame => frame.composite || null),
    transform: keyframes.map(frame => frame.transform || null),
  }
}

function cursorPreviewHtml(svgData) {
  const cards = Object.entries(svgData).map(([name, data]) => `
    <article class="cursor-card">
      <div class="sample"><span class="hotspot"></span><img alt="${name}" src="data:image/svg+xml;base64,${data}"></div>
      <strong>${name}</strong><code>hotspot 3 3</code>
    </article>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>RED-226 cursor evidence</title>
    <style>
      *{box-sizing:border-box}body{margin:0;font:16px system-ui,sans-serif;color:#201b16;background:#f6e8c2}
      h1{font-size:22px;margin:18px 24px 4px}.caption{margin:0 24px 14px;color:#655645}
      .surface{margin:14px 24px;padding:18px;border-radius:14px;display:flex;gap:14px;flex-wrap:wrap;border:3px solid #6d5039}
      .surface.dark{background:#192733;color:#f6e8c2}.surface.light{background:#f6e8c2}
      .cursor-card{width:142px;display:grid;justify-items:center;gap:6px}.sample{position:relative;width:96px;height:96px;border-radius:10px;display:grid;place-items:center;background:#fff8e8}
      .dark .sample{background:#223b4a}.sample img{width:80px;height:80px;image-rendering:auto}.hotspot{position:absolute;left:10px;top:10px;width:8px;height:8px;border:1px solid #de1f36;border-radius:50%;z-index:2}
      code{font-size:11px;opacity:.76}
    </style><h1>RED-226 cursor asset preview</h1><p class="caption">The red marker is the declared SVG hotspot at (3, 3); the image is enlarged for review.</p>
    <section class="surface light">${cards}</section><section class="surface dark">${cards}</section>`
}

async function runNodeHarness() {
  let preview = null
  try {
    await waitForHttp(`${baseUrl}/index.html`, 1500)
  } catch {
    const tsxEntry = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const previewScript = path.join(root, 'scripts', 'run-tutorial-pages-qa.ts')
    ensure(fs.existsSync(tsxEntry), `missing tsx runtime: ${tsxEntry}`)
    preview = spawn(process.execPath, [tsxEntry, previewScript], {
      cwd: root,
      env: { ...process.env, RVB_QA_PAGES_PORT: String(port) },
      stdio: 'inherit',
      windowsHide: true,
    })
    await waitForHttp(`${baseUrl}/index.html`)
  }
  const electronEntry = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  ensure(fs.existsSync(electronEntry), `missing Electron executable: ${electronEntry}`)
  const childEnv = { ...process.env, RVB_RED226_PORT: String(port), RVB_RED226_EVIDENCE_ROOT: evidenceRoot }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(electronEntry, [__filename, '--electron-child'], { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RED-226 Electron smoke timed out after 120 seconds')), 120000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); if (signal) console.error(`Electron signal: ${signal}`); resolve(code == null ? 1 : code) })
  })
  stopProcessTree(child.pid)
  stopProcessTree(preview?.pid)
  if (exitCode !== 0) process.exitCode = exitCode
}

async function runElectronSmoke() {
  const { app, BrowserWindow } = require('electron')
  app.commandLine.appendSwitch('use-gl', 'swiftshader')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  await app.whenReady()
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const evidence = { pages: [], cursor: null, logs: [] }
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  win.focus()
  win.webContents.on('console-message', (_event, level, message) => evidence.logs.push({ level, message: String(message) }))
  win.webContents.on('did-fail-load', (_event, code, description, url) => evidence.logs.push({ level: 'did-fail-load', message: `${code} ${description} ${url}` }))
  const debuggerApi = win.webContents.debugger
  let debuggerAttached = false
  const cdp = async (method, params) => {
    if (!debuggerAttached) { debuggerApi.attach('1.3'); debuggerAttached = true }
    return debuggerApi.sendCommand(method, params)
  }
  const evaluate = expression => win.webContents.executeJavaScript(expression, true)
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression)
        if (value) return value
      } catch (error) { lastError = error }
      await delay(40)
    }
    throw new Error(`${label} timed out: ${lastError || expression}`)
  }
  const load = async (file, width, height) => {
    win.setContentSize(width, height)
    const separator = file.includes('?') ? '&' : '?'
    await win.loadURL(`${baseUrl}/${file}${separator}red226=1`, { extraHeaders: 'Cache-Control: no-cache\n' })
    await delay(120)
  }
  const mouseClick = async point => {
    mouseMove(point)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    await delay(120)
  }
  const prepareRoute = async route => {
    if (route.id !== 'battle') {
      await load(route.file, 1280, 720)
      return
    }
    // Use the real training page so #handCards and its production card CSS
    // are present. The setup values are the same deterministic local fixture
    // used by RED-221; the pointer path below remains native Electron input.
    await load('battle.html?mode=training&playerId=training-red', 1280, 720)
    await waitFor(`document.readyState === 'complete' && typeof PIECES_BY_ID === 'object' && Object.keys(PIECES_BY_ID).length > 0`, 30000, 'battle local data')
    await waitFor(`document.getElementById('trainingSetupOverlay')?.classList.contains('show') === true`, 30000, 'battle training setup')
    const setup = await evaluate(`(() => {
      refreshTrainingSetupPieces()
      const choose = (listId, values) => {
        const wanted = new Set(values)
        const inputs = Array.from(document.querySelectorAll('#' + listId + ' input[type=checkbox]'))
        inputs.forEach(input => { input.checked = wanted.has(input.value) })
        return inputs.filter(input => wanted.has(input.value)).length
      }
      return { first: choose('trainingFirstPieces', ['red-venom', 'dark-muzan', 'dark-akaza']), second: choose('trainingSecondPieces', ['uther', 'anduin']) }
    })()`)
    ensure(setup.first >= 3 && setup.second >= 2, `battle training fixture pieces missing: ${JSON.stringify(setup)}`)
    const startPoint = await evaluate(`(() => { const node=document.querySelector('#trainingSetupOverlay button[onclick="startTrainingFromSetup()"]'); if (!node) return null; const r=node.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    ensure(startPoint && Number.isFinite(startPoint.x) && Number.isFinite(startPoint.y), 'battle training start control missing')
    await mouseClick(startPoint)
    await waitFor(`G && G.turn && G.turn.phase === 'action' && G.pieces?.length > 0 && battlePresentation && _use3d === true`, 30000, 'battle training runtime')
    await waitFor(`battlePresentation && !!document.querySelector('#boardStage3d canvas') && getComputedStyle(document.getElementById('loadingOverlay')).display === 'none'`, 30000, 'battle loading hidden and canvas mounted')
    const endPoint = await evaluate(`(() => {
      const node = document.getElementById('btnEnd')
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.disabled }
    })()`)
    ensure(endPoint && endPoint.visible, 'battle end-turn control unavailable: ' + JSON.stringify(endPoint))
    await mouseClick(endPoint)
    await waitFor(`G && G.turn && G.turn.phase === 'action' && myPlayerId === 'training-blue' && G.turn.currentPlayerId === 'training-blue' && document.querySelectorAll('#handCards > .card-item').length > 0`, 30000, 'real training hand after native end turn')
    const handEvidence = await evaluate(`(() => {
      const hand = document.getElementById('handCards')
      const cards = Array.from(hand?.querySelectorAll(':scope > .card-item') || [])
      const player = G?.players?.find(item => item.playerId === myPlayerId)
      return {
        source: 'native end-turn -> formal renderHand()',
        playerId: myPlayerId,
        phase: G?.turn?.phase || null,
        currentPlayerId: G?.turn?.currentPlayerId || null,
        actionPoints: player?.actionPoints ?? null,
        cards: cards.map(card => ({
          className: String(card.className || ''),
          instanceId: card.dataset.instanceId || null,
          cardId: player?.hand?.find(item => item.instanceId === card.dataset.instanceId)?.cardId || null,
          ariaLabel: card.getAttribute('aria-label'),
          fixture: card.getAttribute('data-red226-fixture'),
          rect: (() => { const r = card.getBoundingClientRect(); return { left:r.left, top:r.top, width:r.width, height:r.height } })(),
        })),
        loadingDisplay: getComputedStyle(document.getElementById('loadingOverlay')).display,
        canvasMounted: !!document.querySelector('#boardStage3d canvas'),
      }
    })()`)
    ensure(handEvidence.cards.length > 0 && handEvidence.cards.every(card => card.fixture === null), 'real training hand unavailable: ' + JSON.stringify(handEvidence))
    await evaluate('window.__RED226_REAL_HAND_EVIDENCE__ = ' + JSON.stringify(handEvidence) + '; true')
  }
  const rootState = () => evaluate(`(() => ({
    classes: [...document.documentElement.classList],
    motionInstance: !!window.__UiMotionInstance,
    finePointer: matchMedia('(pointer: fine)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    link: !!document.querySelector('link[href*="ui-motion.css"]'),
    script: !!document.querySelector('script[src*="ui-motion.js"]'),
    viewport: { width: innerWidth, height: innerHeight },
    overflow: {
      document: document.documentElement.scrollWidth,
      body: document.body?.scrollWidth || 0,
      viewport: innerWidth,
      nodes: [...document.querySelectorAll('*')].filter(node => node.scrollWidth > node.clientWidth + 1).slice(0, 8).map(node => ({ tag: node.tagName, id: node.id || '', className: String(node.className || ''), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })),
    },
  }))()`)
  const chooseTarget = selectors => evaluate(`(() => {
    const selectors = ${JSON.stringify(selectors)}
    const hidden = node => { const r=node.getBoundingClientRect(), s=getComputedStyle(node); return !(r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none') }
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)]
      for (let index=0; index<nodes.length; index++) {
        const node = nodes[index]
        if (hidden(node) || node.disabled || node.matches('[disabled],[aria-disabled="true"],.disabled,.is-disabled,.is-unavailable')) continue
        node.setAttribute('data-red226-target', 'true')
        const r=node.getBoundingClientRect()
        const point={x:Math.max(2,Math.min(innerWidth-2,r.left+r.width*0.82)),y:Math.max(2,Math.min(innerHeight-2,r.top+r.height*0.22))}
        const hit=document.elementFromPoint(point.x,point.y)
        return { selector, index, point, hit: hit?.tagName || null, fixture: node.getAttribute('data-red226-fixture') === 'true', rect:{left:r.left,top:r.top,width:r.width,height:r.height} }
      }
    }
    return null
  })()`)
  const targetState = () => evaluate(`(() => {
    const node=document.querySelector('[data-red226-target]')
    if (!node) return null
    const animations=node.getAnimations().map(animation => (${inspectAnimation.toString()})(animation))
    const additive=animations.filter(animation => animation.composite.some(value => value === 'add'))
    return { transform:getComputedStyle(node).transform, animations, additive, rect:(() => { const r=node.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height} })() }
  })()`)
  const clearTarget = () => evaluate(`document.querySelector('[data-red226-target]')?.removeAttribute('data-red226-target'); true`)
  const mouseMove = point => { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y), movementX: 0, movementY: 0 }) }
  const pageMotion = async route => {
    await prepareRoute(route)
    const initial = await waitFor(`document.documentElement.classList.contains('ui-motion-enabled') && !!window.__UiMotionInstance`, 3000, `${route.id} motion runtime`)
    const state = await rootState()
    ensure(state.link && state.script, `${route.id} missing shared motion assets`)
    ensure(state.classes.includes('ui-motion-enabled'), `${route.id} missing ui-motion-enabled class: ${JSON.stringify(state)}`)
    ensure(state.classes.includes('ui-motion-ready'), `${route.id} missing ui-motion-ready class: ${JSON.stringify(state)}`)
    const target = await chooseTarget(route.selectors)
    ensure(target, `${route.id} has no visible interactive target from ${route.selectors.join(', ')}`)
    const before = await targetState()
    await evaluate(`(() => { window.__RED226_POINTER_LOG=[]; window.__RED226_ANIMATE_LOG=[]; if (!window.__RED226_ANIMATE_WRAPPED__) { const original=Element.prototype.animate; Element.prototype.animate=function(...args) { window.__RED226_ANIMATE_LOG.push({tag:this.tagName,className:String(this.className || ''),id:this.id || '',keyframes:args[0]}); return original.apply(this,args) }; window.__RED226_ANIMATE_WRAPPED__=true }; ['pointerover','pointermove','pointerout'].forEach(type => window.addEventListener(type, event => window.__RED226_POINTER_LOG.push({type,pointerType:event.pointerType || null,target:event.target?.tagName || null}), true)); return true })()`)
    mouseMove(target.point)
    try {
      await waitFor(`(() => { const node=document.querySelector('[data-red226-target]'); return !!node && node.getAnimations().some(animation => (animation.effect?.getKeyframes?.() || []).some(frame => frame.composite === 'add')) })()`, 1500, `${route.id} additive hover animation`)
      await delay(250)
    } catch (error) {
      const debug = await evaluate(`(() => { const n=document.querySelector('[data-red226-target]'); const r=n?.getBoundingClientRect(); const s=n && getComputedStyle(n); const hit=${JSON.stringify(target.point)}; const under=document.elementFromPoint(hit.x,hit.y); return { target:${JSON.stringify(target)}, rect:r && {left:r.left,top:r.top,width:r.width,height:r.height}, style:s && {display:s.display,visibility:s.visibility,pointerEvents:s.pointerEvents,transform:s.transform}, under:under && {tag:under.tagName,className:String(under.className || '')}, bodyClass:document.body.className, rootClass:document.documentElement.className, targetMotion:n?.getAttribute('data-ui-motion'), targetDisabled:n?.disabled, pointerLog:window.__RED226_POINTER_LOG, animateLog:window.__RED226_ANIMATE_LOG, motion:!!window.__UiMotionInstance } })()`)
      throw new Error(`${error.message}; hover target debug: ${JSON.stringify(debug)}`)
    }
    const afterHover = await targetState()
    ensure(afterHover.additive.length <= 1, `${route.id} queued additive animations: ${JSON.stringify(afterHover)}`)
    ensure(afterHover.transform !== before.transform, `${route.id} hover did not change computed transform: ${JSON.stringify({ before, afterHover })}`)
    const realHand = route.id === 'battle' ? await evaluate('window.__RED226_REAL_HAND_EVIDENCE__ || null') : null
    let hoverScreenshot = null
    if (route.id === 'battle') {
      hoverScreenshot = path.join(evidenceRoot, 'final-battle-real-hand-hover.png')
      fs.writeFileSync(hoverScreenshot, (await win.capturePage()).toPNG())
    }
    // The window capture handler resets the decorative state before a real
    // command handler can observe a click/drag. Dispatching only the pointer
    // phases avoids navigating away from the page under test.
    await evaluate(`(() => { const n=document.querySelector('[data-red226-target]'); const r=n.getBoundingClientRect(); n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',pointerId:226,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); return true })()`)
    await delay(30)
    const afterDown = await targetState()
    ensure(afterDown.additive.length <= 1, `${route.id} pointerdown left queued animations: ${JSON.stringify(afterDown)}`)
    // The synthetic phase intentionally avoids a click. A window blur is the
    // same cancellation path used when Electron loses focus and guarantees
    // the pressed state is cleared before the leave assertion below.
    await evaluate(`window.dispatchEvent(new Event('blur')); true`)
    mouseMove({ x: 1000, y: 80 })
    await evaluate(`(() => { const n=document.querySelector('[data-red226-target]'); if (!n) return false; n.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse',relatedTarget:document.body})); return true })()`)
    let restored
    try {
      restored = await waitFor(`(() => { const n=document.querySelector('[data-red226-target]'); if (!n) return false; const s=n.getAnimations().map(animation => (${inspectAnimation.toString()})(animation)); return s.every(animation => !animation.composite.includes('add')) && getComputedStyle(n).transform === ${JSON.stringify(before.transform)} })()`, 1800, `${route.id} hover restore`)
    } catch (error) {
      const debug = await targetState()
      throw new Error(`${error.message}; final target state: ${JSON.stringify(debug)}`)
    }
    const afterRestore = await targetState()
    ensure(restored, `${route.id} did not restore after leave: ${JSON.stringify({ before, afterRestore })}`)

    const layout = state.overflow
    const screenshot = path.join(evidenceRoot, `final-${route.id}-desktop-1280x720.png`)
    fs.writeFileSync(screenshot, (await win.capturePage()).toPNG())
    await clearTarget()
    return { id: route.id, target, initial, before, afterHover, afterDown, afterRestore, realHand, hoverScreenshot, layout, screenshot }
  }

  const checkCursors = async () => {
    const cursorState = await evaluate(`(() => {
      const host=document.createElement('div'); host.id='red226-cursor-fixture'; host.innerHTML='<button id="red226-pointer">pointer</button><button id="red226-disabled" disabled>disabled</button><input id="red226-text" type="text" value="text"><p id="red226-copy">selectable copy</p><div id="boardWrap"><canvas id="red226-board"></canvas></div>'
      host.style.cssText='position:fixed;left:-10000px;top:-10000px;width:2px;height:2px'; document.body.append(host)
      const read=id=>getComputedStyle(document.getElementById(id)).cursor
      document.body.classList.add('target-mode-active')
      const result={body:getComputedStyle(document.body).cursor,pointer:read('red226-pointer'),disabled:read('red226-disabled'),text:read('red226-text'),copy:read('red226-copy'),target:read('red226-board')}
      document.body.classList.remove('target-mode-active'); host.remove(); return result
    })()`)
    for (const [name, value] of Object.entries(cursorState)) ensure(/cursor-(default|pointer|target)\.svg/.test(value) || (name === 'disabled' && value.includes('not-allowed')) || name === 'text' && value.includes('text') || name === 'copy' && value.includes('text'), `cursor ${name} mismatch: ${value}`)
    ensure(cursorState.body.includes('3 3'), `default cursor hotspot missing: ${cursorState.body}`)
    ensure(cursorState.pointer.includes('3 3'), `pointer cursor hotspot missing: ${cursorState.pointer}`)
    ensure(cursorState.target.includes('cursor-target.svg'), `target cursor missing: ${cursorState.target}`)
    return cursorState
  }

  const checkReducedAndTouch = async () => {
    await load('index.html', 1280, 720)
    await waitFor(`document.documentElement.classList.contains('ui-motion-enabled')`, 3000, 'index motion runtime for media checks')
    const target = await chooseTarget(['#tutorialShortcut', '.mode-tab', 'button', 'a[href]'])
    ensure(target, 'media checks have no target')
    const base = await targetState()
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await waitFor(`matchMedia('(prefers-reduced-motion: reduce)').matches`, 1000, 'reduced-motion emulation')
    mouseMove(target.point)
    await delay(180)
    const reduced = await targetState()
    ensure(reduced.additive.length === 0, `reduced-motion produced additive motion: ${JSON.stringify(reduced)}`)
    await cdp('Emulation.setEmulatedMedia', { features: [] })
    await waitFor(`!matchMedia('(prefers-reduced-motion: reduce)').matches`, 1000, 'reduced-motion reset')
    mouseMove({ x: 2, y: 2 }); await delay(80)
    await evaluate(`(() => { const n=document.querySelector('[data-red226-target]'); if (!n) return false; ['pointerdown','pointerup','click'].forEach(type => n.addEventListener(type, event => { event.preventDefault(); event.stopImmediatePropagation() }, { capture: true, once: false })); return true })()`)
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 226, x: target.point.x, y: target.point.y, radiusX: 1, radiusY: 1, force: 1 }] })
    await delay(60)
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await delay(120)
    const touch = await targetState()
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
    ensure(touch, `touch target disappeared: ${JSON.stringify(await rootState())}`)
    ensure(touch.additive.length === 0, `touch input produced hover motion: ${JSON.stringify(touch)}`)
    await clearTarget()
    return { reduced, touch, base }
  }

  const checkMobile = async () => {
    const rows = []
    const failures = []
    for (const route of routePages) {
      for (const [width, height] of mobileSizes) {
        await load(route.file, width, height)
        const state = await waitFor(`!!document.querySelector('link[href*="ui-motion.css"]')`, 3000, `${route.id} mobile load`)
        const layout = await rootState()
        const baseline = await evaluate(`(() => {
          const link=document.querySelector('link[href*="ui-motion.css"]')
          if (link) link.disabled=true
          document.documentElement.classList.remove('ui-motion-enabled','ui-motion-ready','ui-motion-fine-pointer')
          const result={ document: document.documentElement.scrollWidth, body: document.body?.scrollWidth || 0, viewport: innerWidth, nodes: [...document.querySelectorAll('*')].filter(node => node.scrollWidth > node.clientWidth + 1).slice(0, 8).map(node => ({ tag: node.tagName, id: node.id || '', className: String(node.className || ''), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })) }
          if (link) link.disabled=false
          return result
        })()`)
        if (layout.overflow.document > baseline.document + 1 || layout.overflow.body > baseline.body + 1) {
          failures.push({ id: route.id, width, height, overflow: layout.overflow, baseline })
        }
        const screenshot = (route.id === 'index' || route.id === 'battle') ? path.join(evidenceRoot, `final-${route.id}-mobile-${width}x${height}.png`) : null
        if (screenshot) fs.writeFileSync(screenshot, (await win.capturePage()).toPNG())
        rows.push({ id: route.id, width, height, state, layout, baseline, screenshot })
      }
    }
    return { rows, failures }
  }

  try {
    const desktop = []
    for (const route of routePages) desktop.push(await pageMotion(route))
    const cursors = await checkCursors()
    const media = await checkReducedAndTouch()
    const mobile = await checkMobile()
    const svgData = {}
    for (const file of ['cursor-default.svg', 'cursor-pointer.svg', 'cursor-grab.svg', 'cursor-grabbing.svg', 'cursor-target.svg']) {
      svgData[file] = fs.readFileSync(path.join(pagesRoot, 'images', 'ui-motion', file)).toString('base64')
    }
    win.setContentSize(1280, 720)
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cursorPreviewHtml(svgData))}`)
    await delay(120)
    const lightPath = path.join(evidenceRoot, 'final-cursor-preview-light.png')
    fs.writeFileSync(lightPath, (await win.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`document.querySelectorAll('.surface')[0]?.remove(); document.body.style.background='#192733'; document.body.style.color='#f6e8c2'; document.querySelector('.caption').style.color='#d6c6aa'; true`)
    await delay(40)
    const darkPath = path.join(evidenceRoot, 'final-cursor-preview-dark.png')
    fs.writeFileSync(darkPath, (await win.capturePage()).toPNG())
    evidence.cursor = { cursors, lightPath, darkPath }
    evidence.pages = desktop
    evidence.media = media
    evidence.mobile = mobile
    fs.writeFileSync(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2) + '\n')
    ensure(mobile.failures.length === 0, `mobile horizontal overflow: ${JSON.stringify(mobile.failures)}`)
    console.log(JSON.stringify({ passed: true, pages: desktop.map(page => page.id), screenshots: desktop.map(page => page.screenshot), cursorPreview: [lightPath, darkPath], mobileCases: mobile.length }, null, 2))
  } finally {
    if (debuggerAttached) { try { debuggerApi.detach() } catch {} }
    win.destroy()
    app.quit()
  }
}

if (!process.versions.electron) {
  runNodeHarness().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
} else {
  runElectronSmoke().catch(error => { console.error(error.stack || error); process.exit(1) })
}
