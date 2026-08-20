;(function () {
  'use strict'

  const METRICS = Object.freeze({
    cameraTiltDeg: 25,
    cameraHeight: 28,
    pieceWidth: 0.72,
    pieceDepth: 0.56,
    pieceHeight: 0.10,
    panActivationPx: 10,
    minTouchCellPixels: 44,
  })

  const FACTION_EMISSIVE_COLORS = Object.freeze({
    red: 0xef4444,
    blue: 0x3b82f6,
  })

  function cameraPose(input) {
    const mapWidth = Math.max(1, Number(input && input.mapWidth) || 1)
    const mapHeight = Math.max(1, Number(input && input.mapHeight) || 1)
    const target = {
      x: (mapWidth - 1) / 2,
      y: 0,
      z: (mapHeight - 1) / 2,
    }
    const tiltRadians = METRICS.cameraTiltDeg * Math.PI / 180
    const depthOffset = Math.tan(tiltRadians) * METRICS.cameraHeight
    return {
      target,
      position: {
        x: target.x,
        y: METRICS.cameraHeight,
        z: target.z + depthOffset,
      },
    }
  }

  function normalizedGroundDirection(direction, fallback) {
    const x = Number(direction && direction.x) || 0
    const z = Number(direction && direction.z) || 0
    const length = Math.sqrt(x * x + z * z)
    if (length < 0.000001) return fallback
    return { x: x / length, z: z / length }
  }

  function screenPanDelta(input) {
    const right = normalizedGroundDirection(input && input.screenRight, { x: 1, z: 0 })
    const up = normalizedGroundDirection(input && input.screenUp, { x: 0, z: -1 })
    const dx = Number(input && input.dx) || 0
    const dy = Number(input && input.dy) || 0
    const worldPerPixelX = Number(input && input.worldPerPixelX) || 0
    const worldPerPixelY = Number(input && input.worldPerPixelY) || 0
    return {
      x: right.x * -dx * worldPerPixelX + up.x * dy * worldPerPixelY,
      z: right.z * -dx * worldPerPixelX + up.z * dy * worldPerPixelY,
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function clampTarget(input) {
    const mapWidth = Math.max(1, Number(input && input.mapWidth) || 1)
    const mapHeight = Math.max(1, Number(input && input.mapHeight) || 1)
    return {
      x: clamp(Number(input && input.x) || 0, -0.5, mapWidth - 0.5),
      z: clamp(Number(input && input.z) || 0, -0.5, mapHeight - 0.5),
    }
  }

  function pieceFlashStyle(faction, progress) {
    const normalizedProgress = clamp(Number(progress) || 0, 0, 1)
    const factionColor = FACTION_EMISSIVE_COLORS[faction] || FACTION_EMISSIVE_COLORS.red
    const complete = normalizedProgress >= 1
    return {
      color: complete ? factionColor : 0xff2200,
      intensity: complete ? 0.08 : (1 - normalizedProgress) * 0.8,
    }
  }

  function factionMarkerPattern(faction) {
    return faction === 'blue' ? [false, true, true] : [true, false, false]
  }

  window.BattleTacticalGeometry = Object.freeze({
    METRICS,
    cameraPose,
    screenPanDelta,
    clampTarget,
    pieceFlashStyle,
    factionMarkerPattern,
  })
})()
