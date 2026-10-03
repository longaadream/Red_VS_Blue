import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')
const tacticalCss = readFileSync('data/pages/css/battle-tactical-table.css', 'utf8').replace(/\r\n/g, '\n')
const characterDock = readFileSync('data/pages/tabletop-battle/character-dock.js', 'utf8').replace(/\r\n/g, '\n')

function source(name: string) {
  const start = page.indexOf(`function ${name}(`)
  const end = page.indexOf('\n    function ', start + 1)
  if (start < 0 || end < 0) throw new Error(`Missing function: ${name}`)
  return page.slice(start, end)
}

function characterSource(name: string) {
  const start = characterDock.indexOf(`function ${name}(`)
  const end = characterDock.indexOf('\n function ', start + 1)
  if (start < 0 || end < 0) throw new Error(`Missing character-dock function: ${name}`)
  return characterDock.slice(start, end)
}

function markup(id: string) {
  const start = page.indexOf(`<div id="${id}"`)
  if (start < 0) throw new Error(`Missing #${id}`)
  const end = page.indexOf('</div>', start)
  if (end < 0) throw new Error(`Could not isolate #${id}`)
  return page.slice(start, end + '</div>'.length)
}

function classList() {
  const values = new Set<string>()
  return {
    add: (...names: string[]) => names.forEach(name => values.add(name)),
    remove: (...names: string[]) => names.forEach(name => values.delete(name)),
    toggle: (name: string, force?: boolean) => {
      const next = force === undefined ? !values.has(name) : force
      if (next) values.add(name)
      else values.delete(name)
      return next
    },
    contains: (name: string) => values.has(name),
  }
}

function element() {
  const attributes: Record<string, string> = {}
  return {
    classList: classList(),
    style: {} as Record<string, string>,
    hidden: false,
    disabled: false,
    textContent: '',
    setAttribute: (name: string, value: string) => { attributes[name] = value },
    getAttribute: (name: string) => attributes[name] ?? null,
  }
}

interface TreeNode {
  id: string
  classList: ReturnType<typeof classList>
  style: Record<string, string>
  dataset: Record<string, string>
  children: TreeNode[]
  parentElement: TreeNode | null
  previousElementSibling: TreeNode | null
  insertBeforeCalls: number
  appendChild: (child: TreeNode) => TreeNode
  insertBefore: (child: TreeNode, before: TreeNode) => TreeNode
  querySelector: (selector: string) => TreeNode | null
}

function treeNode(id = ''): TreeNode {
  const node: TreeNode = {
    id,
    classList: classList(),
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    children: [] as TreeNode[],
    parentElement: null as TreeNode | null,
    insertBeforeCalls: 0,
    appendChild(child: TreeNode) {
      if (child.parentElement) {
        const index = child.parentElement.children.indexOf(child)
        if (index >= 0) child.parentElement.children.splice(index, 1)
      }
      node.children.push(child)
      child.parentElement = node
      return child
    },
    get previousElementSibling() {
      if (!node.parentElement) return null
      const index = node.parentElement.children.indexOf(node)
      return index > 0 ? node.parentElement.children[index - 1] : null
    },
    insertBefore(child: TreeNode, before: TreeNode) {
      node.insertBeforeCalls += 1
      if (child.parentElement) {
        const index = child.parentElement.children.indexOf(child)
        if (index >= 0) child.parentElement.children.splice(index, 1)
      }
      const index = node.children.indexOf(before)
      node.children.splice(index >= 0 ? index : node.children.length, 0, child)
      child.parentElement = node
      return child
    },
    querySelector(selector: string) {
      return findNodes(node, selector)[0] || null
    },
  }
  return node
}

function findNodes(root: TreeNode, selector: string): TreeNode[] {
  const matches = (node: TreeNode) => {
    if (selector === '.character-cast') return node.classList.contains('character-cast')
    if (selector === '.pi-skill-desc') return node.classList.contains('pi-skill-desc')
    if (selector === '.pi-layout') return node.classList.contains('pi-layout')
    if (selector === '#pieceInfoContent .pi-skill') return node.classList.contains('pi-skill') && hasAncestor(node, 'pieceInfoContent')
    if (selector === '#pieceInfoContent .pi-skill.target-skill-controls') {
      return node.classList.contains('pi-skill') && node.classList.contains('target-skill-controls') && hasAncestor(node, 'pieceInfoContent')
    }
    return false
  }
  const result: TreeNode[] = []
  const visit = (node: TreeNode) => {
    if (matches(node)) result.push(node)
    node.children.forEach(visit)
  }
  visit(root)
  return result
}

function hasAncestor(node: TreeNode, id: string) {
  let current = node.parentElement
  while (current) {
    if (current.id === id) return true
    current = current.parentElement
  }
  return false
}

type OverlayScenario = {
  pendingSkill?: Record<string, unknown> | null
  pendingCardAction?: Record<string, unknown> | null
  targetSubmissionPending?: Record<string, unknown> | null
  authoritativeSelection?: Record<string, unknown> | null
}

function renderScenario(input: OverlayScenario = {}) {
  const overlay = element()
  const sourceName = element()
  const prompt = element()
  const rangeLegend = element()
  const multiSummary = element()
  const confirm = element()
  const cancel = element()
  const controls = element()
  const body = { classList: classList() }
  const elements: Record<string, ReturnType<typeof element>> = {
    targetOverlay: overlay,
    targetSourceName: sourceName,
    targetPromptText: prompt,
    targetRangeLegend: rangeLegend,
    targetMultiSummary: multiSummary,
    targetConfirmButton: confirm,
    targetCancelButton: cancel,
    targetSelectionControls: controls,
  }
  const context = createContext({
    document: { body, getElementById: (id: string) => elements[id] || null },
    window: {},
    pendingSkill: input.pendingSkill === undefined ? { skillId: 'skill-a', preparation: { targetType: 'piece' } } : input.pendingSkill,
    pendingCardAction: input.pendingCardAction ?? null,
    targetSubmissionPending: input.targetSubmissionPending ?? null,
    pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
    G: { pendingTargetSelection: input.authoritativeSelection ?? null, pendingOptionSelection: null },
    closePieceContextMenu: () => undefined,
    placeTargetOverlayHost: () => undefined,
    currentTargetSourceName: () => '当前技能',
    targetStepPrefix: () => '',
    targetTypeText: () => '选择一个目标',
    isPendingBoardMultiTarget: () => false,
    pendingBoardMultiLimits: () => ({ min: 1, max: 1 }),
    pendingBoardMultiSummary: () => '',
  })
  new Script(source('_targetPromptText') + '\n' + source('renderTargetOverlay')).runInContext(context)
  new Script('renderTargetOverlay()').runInContext(context)
  return { context, body, overlay, prompt, cancel, controls }
}

describe('target prompt and controls separation', () => {
  it('presents a skill-specific hint as the public prompt while keeping cancel separate', () => {
    const result = renderScenario({
      pendingSkill: {
        skillId: 'skill-a',
        hint: '选择一个合法敌方目标',
        preparation: { targetType: 'piece' },
      },
    })

    expect(result.prompt.textContent).toBe('选择一个合法敌方目标')
    expect(result.cancel.hidden).toBe(false)
    expect(result.cancel.disabled).toBe(false)
    expect(result.overlay.classList.contains('show')).toBe(true)
    expect(result.controls.classList.contains('show')).toBe(true)
  })

  it('hides the cancel control when the authoritative pending selection forbids cancellation', () => {
    const result = renderScenario({
      authoritativeSelection: { selectionId: 'selection-1', canCancel: false },
    })

    expect(result.prompt.textContent).toBe('选择一个目标')
    expect(result.cancel.hidden).toBe(true)
    expect(result.cancel.disabled).toBe(false)
    expect(result.controls.classList.contains('show')).toBe(true)
  })

  it('keeps the prompt visible and disables controls while a submission awaits authority', () => {
    const result = renderScenario({
      pendingSkill: null,
      targetSubmissionPending: { clientActionId: 'action-1', label: '当前技能' },
    })

    expect(result.body.classList.contains('target-mode-active')).toBe(true)
    expect(result.overlay.classList.contains('show')).toBe(true)
    expect(result.prompt.textContent).toBe('指令已提交 · 等待权威确认')
    expect(result.cancel.disabled).toBe(true)
    expect(result.cancel.textContent).toBe('等待确认…')
    expect(result.controls.classList.contains('show')).toBe(true)
  })

  it('keeps the instruction text and action controls in separate public regions', () => {
    const overlayMarkup = markup('targetOverlay')

    expect(overlayMarkup).toContain('class="target-prompt" id="targetPromptText"')
    expect(overlayMarkup).not.toContain('target-mode-card')
    expect(overlayMarkup).not.toContain('targetCancelButton')
    expect(page).toMatch(/<div id="targetSelectionControls"[\s\S]*?id="targetCancelButton"/)
    expect(page).toMatch(/<div id="targetSelectionControls"[\s\S]*?id="targetConfirmButton"/)
    expect(page).toMatch(/const overlay = document\.getElementById\('targetSelectionControls'\)/)
    expect(page).toMatch(/controls\.classList\.toggle\('show', active\)/)
    expect(page).toMatch(/skillRow\.insertBefore\(overlay, description\)/)
    expect(page).toMatch(/overlay\.parentElement !== skillRow \|\| description\.previousElementSibling !== overlay/)
    expect(page).toMatch(/target-skill-controls/)
    expect(page).toMatch(/draft\.skill && targetSubmissionPending\.draft\.skill\.skillId/)
    expect(page).toMatch(/resolve: button => button\.dataset\.targetMode \? null/)
    expect(page).toMatch(/window\.refreshTargetSkillButtonState\(\)/)
    expect(page).toMatch(/cancelButton\.hidden = currentSkillButton \|\|/)
    expect(page).toMatch(/event\.key === 'Escape' && \(pendingSkill \|\| pendingCardAction \|\| targetSubmissionPending\)/)
    expect(tacticalCss).toMatch(/body #targetOverlay #targetPromptText[\s\S]*color: #ffe08a !important/)
    expect(tacticalCss).toMatch(/character-cast\.is-cancel-mode[\s\S]*font-size: 16px[\s\S]*font-weight: 900/)
    expect(tacticalCss).toMatch(/character-cast\.is-cancel-mode[\s\S]*color: var\(--comic-ink, #30231c\) !important/)
    expect(tacticalCss).toMatch(/character-cast\.is-cancel-disabled[\s\S]*color: var\(--battle-text-muted, #655443\) !important/)
    expect(characterDock).toMatch(/function preserveTargetControlsBeforeRender\(\)/)
    expect(characterDock).toMatch(/preserveTargetControlsBeforeRender\(\);\s*nativeRender\(piece,true\)/)
    expect(characterDock).toMatch(/targetSubmissionPending\)\&\&typeof renderTargetOverlay==='function'\)renderTargetOverlay\(\)/)
    expect(characterDock).toMatch(/button\.dataset\.targetMode==='cancel'/)
    expect(characterDock).toMatch(/dispatchBattleIntent\(\{type:'cancel-target'\}\)/)
    expect(characterDock).toMatch(/setCancelMeta\(skillMeta,cancelMode,cancelStateLabel\)/)
    expect(characterDock).toMatch(/targetControls\.nextElementSibling===description/)
  })

  it('uses the skill cost slot for cancel state and restores its original metadata', () => {
    const meta = Object.assign(element(), {
      dataset: {} as Record<string, string>,
      innerHTML: '<span>行动 1 · 冷却 1</span>',
    })
    const context = createContext({ meta })
    new Script(`${characterSource('setCancelMeta')}\nsetCancelMeta(meta,true,'')`).runInContext(context)

    expect(meta.textContent).toBe('再次点击取消')
    expect(meta.classList.contains('character-cast-cancel-label')).toBe(true)
    expect(meta.dataset.cancelOriginalHtml).toBe('<span>行动 1 · 冷却 1</span>')

    new Script("setCancelMeta(meta,false,'等待确认…')").runInContext(context)
    expect(meta.textContent).toBe('等待确认…')
    expect(meta.classList.contains('character-cast-cancel-label')).toBe(false)
    expect(meta.classList.contains('character-cast-cancel-disabled-label')).toBe(true)

    new Script("setCancelMeta(meta,false,'')").runInContext(context)
    expect(meta.innerHTML).toBe('<span>行动 1 · 冷却 1</span>')
    expect(meta.dataset.cancelOriginalHtml).toBeUndefined()
  })

  it('forwards active-card body clicks but ignores controls, text selection and scroll gestures', async () => {
    const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {}
    const button = Object.assign(element(), {
      dataset: {} as Record<string, string>,
      click: vi.fn(),
    })
    let activeButton: typeof button | null = button
    const row = Object.assign(element(), {
      dataset: {} as Record<string, string>,
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        ;(listeners[type] ||= []).push(listener)
      },
      querySelector: (selector: string) => selector === '.character-cast' ? activeButton : null,
      dispatch: (type: string, event: Record<string, unknown>) => {
        ;(listeners[type] || []).forEach(listener => listener(event))
      },
    })
    let selectionText = ''
    const context = createContext({
      row,
      window: { getSelection: () => ({ toString: () => selectionText }) },
    })
    new Script(`${characterSource('skillCardClickTargetAllowed')}\n${characterSource('bindSkillCardActivation')}\nbindSkillCardActivation(row)`).runInContext(context)

    const blank = { closest: () => null }
    const keyword = { closest: () => ({}) }
    const pointer = { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 }
    row.dispatch('pointerdown', pointer)
    row.dispatch('pointerup', pointer)
    row.dispatch('click', { target: blank, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledOnce()

    row.dispatch('click', { target: keyword, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledOnce()

    selectionText = '选中的技能说明'
    row.dispatch('click', { target: blank, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledOnce()
    selectionText = ''

    row.dispatch('pointerdown', pointer)
    row.dispatch('pointermove', { ...pointer, clientX: 20 })
    row.dispatch('pointerup', { ...pointer, clientX: 20 })
    await new Promise(resolve => setTimeout(resolve, 0))
    row.dispatch('click', { target: blank, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledOnce()

    const cancelledPointer = { ...pointer, pointerId: 2 }
    row.dispatch('pointerdown', cancelledPointer)
    row.dispatch('pointercancel', cancelledPointer)
    await new Promise(resolve => setTimeout(resolve, 0))
    row.dispatch('click', { target: blank, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledOnce()

    row.dispatch('pointerdown', pointer)
    row.dispatch('pointerup', pointer)
    row.dispatch('click', { target: blank, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledTimes(2)

    activeButton = null
    row.dispatch('click', { target: blank, button: 0, defaultPrevented: false })
    expect(button.click).toHaveBeenCalledTimes(2)
  })

  it('keeps the fallback cancel control when a matching skill row is closed', () => {
    const overlay = element()
    const prompt = element()
    const multiSummary = element()
    const confirm = element()
    const cancel = element()
    const controls = element()
    const modal = element()
    const skillButton = Object.assign(element(), { dataset: { skillId: 'skill-a', targetMode: 'cancel' } })
    modal.classList.add('character-dock')
    modal.style.display = 'none'
    const body = { classList: classList() }
    const elements: Record<string, ReturnType<typeof element>> = {
      targetOverlay: overlay,
      targetPromptText: prompt,
      targetMultiSummary: multiSummary,
      targetConfirmButton: confirm,
      targetCancelButton: cancel,
      targetSelectionControls: controls,
      pieceInfoModal: modal,
    }
    const context = createContext({
      document: {
        body,
        getElementById: (id: string) => elements[id] || null,
        querySelectorAll: () => [skillButton],
      },
      window: {},
      pendingSkill: { skillId: 'skill-a', preparation: { targetType: 'piece' } },
      pendingCardAction: null,
      targetSubmissionPending: null,
      pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
      G: { pendingTargetSelection: null, pendingOptionSelection: null },
      currentPieceInfoSource: 'board',
      closePieceContextMenu: () => undefined,
      placeTargetOverlayHost: () => undefined,
      targetStepPrefix: () => '',
      targetTypeText: () => '选择一个目标',
      isPendingBoardMultiTarget: () => false,
      pendingBoardMultiLimits: () => ({ min: 1, max: 1 }),
      pendingBoardMultiSummary: () => '',
    })
    new Script(source('_targetPromptText') + '\n' + source('renderTargetOverlay')).runInContext(context)
    new Script('renderTargetOverlay()').runInContext(context)
    expect(cancel.hidden).toBe(false)

    modal.style.display = 'flex'
    body.classList.add('character-dock-open')
    new Script('renderTargetOverlay()').runInContext(context)
    expect(cancel.hidden).toBe(true)
  })

  it('mounts the existing controls beside the matching skill title and before its description', () => {
    const body = treeNode('documentBody')
    const modal = treeNode()
    modal.classList.add('character-dock')
    const layout = treeNode('pieceInfoLayout')
    layout.classList.add('pi-layout')
    const content = treeNode('pieceInfoContent')
    const row = treeNode('skillRow')
    row.classList.add('pi-skill')
    const cast = treeNode()
    cast.classList.add('character-cast')
    cast.dataset.skillId = 'skill-a'
    const description = treeNode()
    description.classList.add('pi-skill-desc')
    row.appendChild(cast)
    row.appendChild(description)
    content.appendChild(row)
    layout.appendChild(content)
    modal.appendChild(layout)
    const controls = treeNode('targetSelectionControls')
    body.appendChild(modal)
    body.appendChild(controls)

    const elements: Record<string, TreeNode> = { pieceInfoModal: modal, targetSelectionControls: controls }
    const context = createContext({
      document: {
        body,
        getElementById: (id: string) => elements[id] || null,
        querySelectorAll: (selector: string) => findNodes(body, selector),
      },
      pendingSkill: { skillId: 'skill-a' },
      targetSubmissionPending: null,
      currentPieceInfoSource: 'board',
    })
    new Script(source('placeTargetOverlayHost')).runInContext(context)
    new Script('placeTargetOverlayHost(true)').runInContext(context)

    expect(controls.parentElement?.id).toBe('skillRow')
    expect(row.children.indexOf(controls)).toBe(row.children.indexOf(description) - 1)
    expect(cast.children).not.toContain(controls)
    expect(row.classList.contains('target-skill-controls')).toBe(true)

  // A redraw pass must reuse the already adjacent node. Moving it again
  // would blur a focused cancel button even though the target row is stable.
  const movesAfterFirstMount = row.insertBeforeCalls
  new Script('placeTargetOverlayHost(true)').runInContext(context)
  expect(row.insertBeforeCalls).toBe(movesAfterFirstMount)

    // A stale/unknown skill row uses the public body fallback and clears the
    // previous row marker instead of leaving controls in a dead row.
    context.pendingSkill = { skillId: 'missing-skill' }
    new Script('placeTargetOverlayHost(true)').runInContext(context)
    expect(controls.parentElement?.id).toBe('pieceInfoLayout')
    expect(row.classList.contains('target-skill-controls')).toBe(false)

    new Script('placeTargetOverlayHost(false)').runInContext(context)
    expect(controls.parentElement?.id).toBe('documentBody')
  })

  it('restores the normal target hint after temporary invalid-target feedback', () => {
    const prompt = element()
    const bubble = element()
    const timerCallbackRef: { current: (() => void) | null } = { current: null }
    const renderTargetOverlay = vi.fn(() => { prompt.textContent = '选择一个目标' })
    const context = createContext({
      document: { getElementById: (id: string) => id === 'targetPromptText' ? prompt : id === 'dmBubble' ? bubble : null },
      pendingSkill: { skillId: 'skill-a' },
      pendingCardAction: null,
      lastDmFeedback: { key: '', at: 0 },
      dmFeedbackTimer: null,
      dmFeedbackLine: undefined,
      requestAnimationFrame: (callback: () => void) => callback(),
      setTimeout: (callback: () => void) => { timerCallbackRef.current = callback; return 1 },
      clearTimeout: () => undefined,
      ensureBattleFeedbackAudio: () => ({ play: () => undefined }),
      renderTargetOverlay,
      TIMER_PREVIEW_MODE: false,
      authoritativeTurnTimer: null,
      authoritativePendingTimer: null,
      deadlines: [],
      dmFeedbackTimerId: null,
      Date,
    })
    new Script(source('dmFeedbackLine') + '\n' + source('showDmFeedback')).runInContext(context)

    new Script("showDmFeedback('目标不在技能范围内')").runInContext(context)
    expect(prompt.textContent).toBe('这个目标不符合技能要求。')
    expect(bubble.textContent).toBe('这个目标不符合技能要求。')
    expect(bubble.classList.contains('is-visible')).toBe(true)

    timerCallbackRef.current?.()
    expect(renderTargetOverlay).toHaveBeenCalledOnce()
    expect(prompt.textContent).toBe('选择一个目标')
  })
})
