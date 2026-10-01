/* RED-224 touch-drag acceptance steps for the existing Electron battle harness. */

module.exports = async function runRed224SkillDragSmoke({
  cdp,
  delay,
  evaluate,
  fixtureInstaller,
  tap,
  boardPoint,
  closeTileStatusIfOpen,
  skillSelector,
  pointFor,
  snapshot,
  ensure,
  waitFor,
}) {
  const dragTouchTo = async (from, to) => {
    const touchPoint = point => ({
      id: 1,
      x: Math.round(point.x),
      y: Math.round(point.y),
      radiusX: 1,
      radiusY: 1,
      force: 1,
    })
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touchPoint(from)],
    })
    await delay(80)
    const steps = 10
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps
      await cdp('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touchPoint({
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
        })],
      })
      await delay(35)
    }
  }

  const finishTouchDrag = async (type = 'touchEnd') => {
    await cdp('Input.dispatchTouchEvent', { type, touchPoints: [] })
    await delay(320)
  }

  const prepareTouchDrag = async () => {
    const touchFixture = await evaluate(fixtureInstaller)
    await evaluate('window.__RED221_PUTS = []')
    await tap(await boardPoint(touchFixture.caster), 'mouse')
    await closeTileStatusIfOpen('mouse')
    await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(skillSelector)})
      if (button) button.scrollIntoView({ block: 'center', inline: 'nearest' })
      return !!button
    })()`)
    await delay(180)

    const source = await pointFor(`(() => {
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(skillSelector)}))
      const button = buttons.find(candidate => {
        const rect = candidate.getBoundingClientRect()
        const style = getComputedStyle(candidate)
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden'
      })
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`, 'visible character cast button')
    const armed = await snapshot('touch-drag-armed')
    ensure(
      armed.selectedPieceId === touchFixture.casterId && !armed.pendingSkill,
      `Touch drag did not start from a clean caster selection: ${JSON.stringify(armed)}`,
    )
    return { fixture: touchFixture, source, armed }
  }

  const waitForReadyPreview = async label => {
    try { await waitFor(
      `skillPreviewController && skillPreviewController.getDiagnostics().active?.displayed
        && document.querySelector('.skill-preview-badge')?.textContent?.includes('点击或松手释放')`,
      5000,
      label,
    ) } catch (error) {
      const debug = await evaluate(`({
        flow: { selectedPieceId, pendingSkill, targetSubmissionPending, pendingActionFeedback },
        diagnostics: skillPreviewController?.getDiagnostics(),
        badge: document.querySelector('.skill-preview-badge')?.textContent,
        events: window.__RED224_DRAG_EVENTS,
      })`)
      throw new Error(String(error) + '\\nDrag evidence: ' + JSON.stringify(debug))
    }
    return evaluate(`({
      diagnostics: skillPreviewController.getDiagnostics(),
      badge: document.querySelector('.skill-preview-badge')?.textContent,
      timings: skillPreviewDisplayTimings.at(-1) || null,
      puts: window.__RED221_PUTS.length,
    })`)
  }

  const releaseSetup = await prepareTouchDrag()
  await evaluate(`(() => {
    window.__RED224_DRAG_EVENTS = []
    for (const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture']) {
      document.addEventListener(type, event => {
        const cell = BattleRenderer3D.screenToCell(event.clientX, event.clientY)
        __RED224_DRAG_EVENTS.push({ type, id: event.pointerId, target: event.target.className,
          captured: document.documentElement.hasPointerCapture(event.pointerId), x: event.clientX, y: event.clientY, cell })
      }, true)
    }
    return true
  })()`)
  const releaseBefore = await snapshot('touch-drag-before-release')
  await dragTouchTo(releaseSetup.source, await boardPoint(releaseSetup.fixture.validTarget))
  const releasePreview = await waitForReadyPreview('touch drag ready preview')
  ensure(
    releasePreview.puts === releaseBefore.trainingPutCalls,
    `Preview drag sent a PUT before release: ${JSON.stringify(releasePreview)}`,
  )
  ensure(
    releasePreview.timings
      && Number.isFinite(releasePreview.timings.durationMs)
      && Number.isFinite(releasePreview.timings.nextFrameMs),
    `Preview display timing was not recorded: ${JSON.stringify(releasePreview)}`,
  )
  await finishTouchDrag('touchEnd')
  await waitFor(
    `window.__RED221_PUTS.length === ${releaseBefore.trainingPutCalls + 1}`,
    5000,
    'touch drag release PUT',
  )
  const releasePut = await evaluate('window.__RED221_PUTS.at(-1)')
  ensure(
    releasePut?.targetPieceId === releaseSetup.fixture.validTargetId,
    `Touch drag released the wrong target: ${JSON.stringify(releasePut)}`,
  )
  await delay(900)
  const releaseAccepted = await snapshot('touch-drag-after-release')
  ensure(
    releaseAccepted.trainingPutCalls === releaseBefore.trainingPutCalls + 1,
    `Touch drag release did not submit exactly one PUT: ${JSON.stringify(releaseAccepted)}`,
  )
  ensure(
    releaseAccepted.targetHp < releaseBefore.targetHp
      && !releaseAccepted.pendingSkill
      && !releaseAccepted.targetSubmissionPending
      && !releaseAccepted.targetMode,
    `Touch drag release did not resolve authoritatively: ${JSON.stringify({ releaseBefore, releaseAccepted })}`,
  )

  const cancelSetup = await prepareTouchDrag()
  const cancelBefore = await snapshot('touch-drag-before-cancel')
  await dragTouchTo(cancelSetup.source, await boardPoint(cancelSetup.fixture.validTarget))
  const cancelPreview = await waitForReadyPreview('touch drag cancel preview')
  await finishTouchDrag('touchCancel')
  const cancelled = await snapshot('touch-drag-after-cancel')
  ensure(
    cancelPreview.puts === cancelBefore.trainingPutCalls
      && cancelled.trainingPutCalls === cancelBefore.trainingPutCalls
      && cancelled.pendingSkill?.skillId === 'venom-claw-rend'
      && !cancelled.targetSubmissionPending
      && cancelled.targetMode,
    `Touch drag cancel submitted or exited target mode: ${JSON.stringify({ cancelPreview, cancelBefore, cancelled })}`,
  )

  const illegalSetup = await prepareTouchDrag()
  const illegalBefore = await snapshot('touch-drag-before-illegal')
  await dragTouchTo(illegalSetup.source, await boardPoint(illegalSetup.fixture.invalidPiece))
  await finishTouchDrag('touchEnd')
  const illegalAfter = await snapshot('touch-drag-after-illegal')
  ensure(
    illegalAfter.trainingPutCalls === illegalBefore.trainingPutCalls
      && illegalAfter.pendingSkill?.skillId === 'venom-claw-rend'
      && illegalAfter.targetMode
      && !illegalAfter.targetSubmissionPending,
    `Illegal touch drag changed the pending target flow: ${JSON.stringify({ illegalBefore, illegalAfter })}`,
  )

  return {
    release: { releasePreview, releasePut, releaseBefore, releaseAccepted },
    cancel: { cancelPreview, cancelBefore, cancelled },
    illegal: { illegalBefore, illegalAfter },
  }
}
