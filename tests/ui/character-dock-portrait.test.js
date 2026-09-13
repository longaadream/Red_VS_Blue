import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

class Element {
  children = []
  dataset = {}
  style = {}
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false } }
  setAttribute(key, value) { this[key] = value }
  removeAttribute(key) { delete this[key] }
  append(...items) { this.children.push(...items) }
  prepend(item) { this.children.unshift(item) }
  addEventListener() {}
  querySelectorAll() { return [] }
}

function fixture() {
  const modal = new Element(), header = new Element(), sheet = new Element(), panel = new Element()
  sheet.scrollTop = 0
  modal.querySelector = selector => selector === '.pi-header' ? header : sheet
  const noop = () => {}
  const env = {
    document: { body: new Element(), getElementById: id => id === 'pieceInfoModal' ? modal : panel,
      createElement: () => new Element(), querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop },
    renderPieceInfoRecord: noop, renderDeploymentPieceInfoError: noop, renderPieceContextMenu: noop,
    showPieceInfo: noop, closePieceInfo: noop, render: noop, setStatusMsg: noop,
    pieceInfoDisplaySkills: () => [], handlePieceInfoModalKeydown: noop,
    currentPieceInfoSource: 'board', selectedPieceId: null, myPlayerId: 'me',
    pendingSkill: null, pendingCardAction: null, targetSubmissionPending: false, pendingActionFeedback: false,
    G: {}, PIECES_BY_ID: { enemy: { image: 'enemy.jpg' }, candidate: { image: 'candidate.jpg' } },
  }
  env.window = env
  runInNewContext(readFileSync('data/pages/tabletop-battle/character-dock.js', 'utf8'), env)
  return { env, portrait: header.children[0] }
}

describe('character portrait across deployment inspection', () => {
  it('replaces the previous opponent portrait when opening a deployment candidate', () => {
    const { env, portrait } = fixture()
    env.renderPieceInfoRecord({ templateId: 'enemy', name: '对手', ownerPlayerId: 'other' })
    expect(portrait.src).toBe('images/enemy.jpg')
    env.currentPieceInfoSource = 'deployment'
    env.renderPieceInfoRecord({ templateId: 'candidate', name: '候选' })
    expect(portrait.src).toBe('images/candidate.jpg')
    expect(portrait.alt).toBe('候选头像')
  })

  it('clears the old image for missing candidate data and can recover on the next board inspection', () => {
    const { env, portrait } = fixture()
    env.renderPieceInfoRecord({ templateId: 'enemy', name: '对手' })
    env.currentPieceInfoSource = 'deployment'
    env.renderDeploymentPieceInfoError({ templateId: 'missing', name: '无资料候选' })
    expect(portrait.hidden).toBe(true)
    expect(portrait.src).toBeUndefined()
    expect(portrait.alt).toBe('')
    env.currentPieceInfoSource = 'board'
    env.renderPieceInfoRecord({ templateId: 'candidate', name: '候选' })
    expect(portrait.hidden).toBe(false)
    expect(portrait.src).toBe('images/candidate.jpg')
  })
})
