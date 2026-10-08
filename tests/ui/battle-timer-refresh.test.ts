import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const scheduler = page.slice(page.indexOf('    function scheduleDeadlineStatusRefresh()'), page.indexOf('    async function selectReserveDeploymentPiece('))
const projection = readFileSync('data/pages/js/battle-ui/turn-timer-status.js', 'utf8')

function harness(preview = true) {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const previewStart = page.indexOf('    const TIMER_PREVIEW_MODE =')
  const previewEnd = page.indexOf('    if (TUTORIAL_MODE)', previewStart)
  const previewContext = createContext({ Date, params: { get: () => '1' } })
  new Script(page.slice(previewStart, previewEnd)).runInContext(previewContext)
  const timer = preview
    ? new Script('TIMER_PREVIEW_TIMER').runInContext(previewContext)
    : { status: 'running', deadlineAt: 45000, burnStartsAt: 15000, durationMs: 45000 }
  const views: Array<{ clockText: string; burning: boolean; sandRemaining: number }> = []
  const deployment = vi.fn()
  const context = createContext({
    Date, setTimeout, clearTimeout, deadlineStatusTimer: null, battlePageDisposed: false,
    TIMER_PREVIEW_MODE: preview, TIMER_PREVIEW_TIMER: preview ? timer : null,
    authoritativeTurnTimer: preview ? null : timer, authoritativePendingTimer: null,
    G: { deployment: { mode: 'progressive-reserve-v1', status: 'awaiting-reserve-deploy' } },
    currentAuthorityNow: () => Date.now(), renderDeploymentStatus: deployment,
    render: () => { throw new Error('Clock tick must not render the board') },
  })
  new Script(projection).runInContext(context)
  context.renderTurnTimerStatus = () => views.push(context.RvBTurnTimerStatus.create({
    timer: context.authoritativeTurnTimer || context.TIMER_PREVIEW_TIMER,
    pendingTimer: context.authoritativePendingTimer, now: Date.now(),
  }))
  new Script(scheduler).runInContext(context)
  return { context, views, deployment, schedule: () => context.scheduleDeadlineStatusRefresh() }
}

afterEach(() => vi.useRealTimers())

describe('independent battle clock refresh', () => {
  it('updates the preview without pointer input through burning and zero, then stops', () => {
    const h = harness()
    h.schedule()
    vi.advanceTimersByTime(1000)
    expect(h.views.at(-1)).toMatchObject({ clockText: '00:44', burning: false })
    expect(h.views.at(-1)?.sandRemaining).toBeCloseTo(44 / 45)
    vi.advanceTimersByTime(14000)
    expect(h.views.at(-1)).toMatchObject({ clockText: '00:30', burning: true })
    vi.advanceTimersByTime(30000)
    expect(h.views.at(-1)).toMatchObject({ clockText: '00:00', sandRemaining: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(h.deployment).not.toHaveBeenCalled()
  })

  it('updates authority and response clocks without redrawing reserve choices', () => {
    const h = harness(false)
    h.schedule()
    vi.advanceTimersByTime(1000)
    expect(h.views.at(-1)?.clockText).toBe('00:44')
    h.context.authoritativePendingTimer = { status: 'running', deadlineAt: 16000, durationMs: 15000 }
    h.schedule()
    vi.advanceTimersByTime(1000)
    expect(h.views.at(-1)?.clockText).toBe('00:14')
    expect(h.deployment).not.toHaveBeenCalled()
  })

  it('retains legacy deployment countdown updates and cancels on disposal', () => {
    const h = harness(false)
    h.context.G.deployment = { status: 'awaiting-locks', deadlineAt: 45000 }
    h.schedule()
    h.schedule()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(h.deployment).toHaveBeenCalledTimes(1)
    h.context.battlePageDisposed = true
    h.schedule()
    vi.advanceTimersByTime(5000)
    expect(h.deployment).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
