;(function (root) {
  'use strict'

  const MENU_PADDING = 8
  const MENU_GAP = 14

  function clamp(value, minimum, maximum) {
    if (maximum < minimum) return minimum
    return Math.max(minimum, Math.min(maximum, value))
  }

  function handArc(index, count) {
    const total = Math.max(0, Number(count) || 0)
    if (total <= 1) return { angle: 0, lift: 0, zIndex: 1 }

    const safeIndex = clamp(Number(index) || 0, 0, total - 1)
    const progress = (safeIndex / (total - 1)) * 2 - 1
    const maximumAngle = Math.min(20, total * 4)
    const distanceFromCenter = Math.abs(progress)

    return {
      angle: Number((progress * maximumAngle).toFixed(3)),
      lift: Number((-(progress * progress) * 10).toFixed(3)),
      zIndex: Math.max(1, Math.round((1 - distanceFromCenter) * total) + 1),
    }
  }

  function placeMenu(anchor, menu, bounds) {
    const anchorLeft = Number(anchor && anchor.left) || 0
    const anchorTop = Number(anchor && anchor.top) || 0
    const menuWidth = Math.max(0, Number(menu && menu.width) || 0)
    const menuHeight = Math.max(0, Number(menu && menu.height) || 0)
    const topPadding = Math.max(MENU_PADDING, Number(bounds && bounds.topPadding) || MENU_PADDING)
    const boundsWidth = Math.max(0, Number(bounds && bounds.width) || 0)
    const boundsHeight = Math.max(0, Number(bounds && bounds.height) || 0)
    const availableRight = boundsWidth - anchorLeft
    const side = availableRight >= menuWidth + MENU_GAP + MENU_PADDING ? 'right' : 'left'
    const rawLeft = side === 'right'
      ? anchorLeft + MENU_GAP
      : anchorLeft - menuWidth - MENU_GAP
    const rawTop = anchorTop - menuHeight / 2
    const left = clamp(rawLeft, MENU_PADDING, boundsWidth - menuWidth - MENU_PADDING)
    const top = clamp(rawTop, topPadding, boundsHeight - menuHeight - MENU_PADDING)

    return {
      left: Number(left.toFixed(3)),
      top: Number(top.toFixed(3)),
      side: side,
      originX: Number(clamp(anchorLeft - left, 0, menuWidth).toFixed(3)),
      originY: Number(clamp(anchorTop - top, 0, menuHeight).toFixed(3)),
    }
  }

  function placeEdgeDock(anchor, menu, bounds, previousSide) {
    const anchorLeft = Number(anchor && anchor.left) || 0
    const anchorTop = Number(anchor && anchor.top) || 0
    const menuWidth = Math.max(0, Number(menu && menu.width) || 0)
    const menuHeight = Math.max(0, Number(menu && menu.height) || 0)
    const boundsWidth = Math.max(0, Number(bounds && bounds.width) || 0)
    const boundsHeight = Math.max(0, Number(bounds && bounds.height) || 0)
    const topPadding = Math.max(MENU_PADDING, Number(bounds && bounds.topPadding) || MENU_PADDING)
    const bottomPadding = Math.max(MENU_PADDING, Number(bounds && bounds.bottomPadding) || MENU_PADDING)
    const midpoint = boundsWidth / 2
    const hysteresis = Math.min(64, Math.max(28, boundsWidth * 0.05))
    let side

    if (previousSide === 'left' && anchorLeft >= midpoint - hysteresis) side = 'left'
    else if (previousSide === 'right' && anchorLeft <= midpoint + hysteresis) side = 'right'
    else side = anchorLeft >= midpoint ? 'left' : 'right'

    const left = side === 'left'
      ? MENU_PADDING
      : Math.max(MENU_PADDING, boundsWidth - menuWidth - MENU_PADDING)
    const availableHeight = Math.max(0, boundsHeight - topPadding - bottomPadding)
    const rawTop = topPadding + (availableHeight - menuHeight) / 2
    const top = clamp(rawTop, topPadding, boundsHeight - bottomPadding - menuHeight)

    return {
      left: Number(left.toFixed(3)),
      top: Number(top.toFixed(3)),
      side: side,
      originX: side === 'left' ? 0 : menuWidth,
      originY: Number(clamp(anchorTop - top, 0, menuHeight).toFixed(3)),
    }
  }

  root.BattleContextLayout = {
    handArc: handArc,
    placeMenu: placeMenu,
    placeEdgeDock: placeEdgeDock,
  }
})(typeof window !== 'undefined' ? window : globalThis)
