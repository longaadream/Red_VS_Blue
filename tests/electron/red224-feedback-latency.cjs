/* Browser-only probes: measure input, transport, authority display and real floaters. */
exports.install = async function (evaluate) {
  await evaluate(`(() => {
    const timing = window.__RED224_FEEDBACK_TIMING__ = {}
    const mark = key => { if (timing[key] == null) timing[key] = performance.now() }
    // Pointer capture keeps a touch release targeted at the drag root/button,
    // so measure the next pointerup rather than requiring the board DOM target.
    const onInput = event => {
      if (timing.inputAt != null) return
      // The delegated drag listener may submit earlier in this same capture
      // phase. The event timestamp measures arrival, not our listener order.
      const timestamp = Number(event.timeStamp)
      const current = performance.now()
      timing.inputAt = Number.isFinite(timestamp) && Math.abs(timestamp - current) < 10000
        ? timestamp : current
    }
    document.addEventListener('pointerup', onInput, true)
    timing.removeInput = () => document.removeEventListener('pointerup', onInput, true)
    const transport = window.trainingApiFetch
    window.trainingApiFetch = async function (method) {
      if (method !== 'PUT') return transport.apply(this, arguments)
      mark('submitAt')
      const result = await transport.apply(this, arguments)
      mark('authorityAt')
      return result
    }
    const update = battlePresentation.update
    battlePresentation.update = function () {
      if (timing.authorityAt != null) mark('displayUpdateAt')
      return update.apply(this, arguments)
    }
    const floater = BattleRenderer3D.spawnFloater
    const pending = BattleRenderer3D.setPendingFeedback
    BattleRenderer3D.setPendingFeedback = function (pieceId) {
      if (pieceId) mark('acknowledgementAt')
      return pending.apply(this, arguments)
    }
    const animation = BattleRenderer3D.animateAction
    BattleRenderer3D.animateAction = function () {
      if (timing.authorityAt != null) mark('animationAt')
      return animation.apply(this, arguments)
    }
    BattleRenderer3D.spawnFloater = function (x, y, text, color, big, options) {
      if (timing.submitAt != null && !(options && options.preview)) mark('effectAt')
      return floater.apply(this, arguments)
    }
    timing.restore = () => {
      window.trainingApiFetch = transport
      battlePresentation.update = update
      BattleRenderer3D.spawnFloater = floater
      BattleRenderer3D.setPendingFeedback = pending
      BattleRenderer3D.animateAction = animation
      timing.removeInput()
    }
    return true
  })()`)
}

exports.finish = async function (evaluate, waitFor) {
  await waitFor('window.__RED224_FEEDBACK_TIMING__?.effectAt != null', 8000, 'real skill feedback latency')
  const measured = await evaluate(`(() => {
    const t = window.__RED224_FEEDBACK_TIMING__
    t.restore()
    return {
      inputToSubmitMs: t.submitAt - t.inputAt,
      inputToAcknowledgementMs: t.acknowledgementAt - t.inputAt,
      authorityToAnimationMs: t.animationAt - t.authorityAt,
      submitToAuthorityMs: t.authorityAt - t.submitAt,
      authorityToDisplayUpdateMs: t.displayUpdateAt - t.authorityAt,
      authorityToEffectMs: t.effectAt - t.authorityAt,
      inputToEffectMs: t.effectAt - t.inputAt,
    }
  })()`)
  if (process.env.RVB_REQUIRE_FEEDBACK_FAST === '1' &&
      (!(measured.authorityToEffectMs >= 0) || measured.authorityToEffectMs > 500)) {
    throw new Error('Authority feedback still waits on the banner: ' + JSON.stringify(measured))
  }
  return measured
}
