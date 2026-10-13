import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { clearRuleCache, loadRuleById } from '../../lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'
import { prepareDraftTrainingPreview } from '../../electron-editor/training-draft-worker'
import { profileIdentityFromDraftSnapshot } from '../../electron-editor/training-preview-worker'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function writeJson(root: string, relative: string, value: unknown): void {
  const file = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'rvb-draft-training-')); roots.push(root)
  const skill = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/skills/biotic-grenade.json'), 'utf8'))
  writeJson(root, 'data/maps/manifest.json', ['arena'])
  writeJson(root, 'data/maps/arena.json', { id: 'arena', width: 4, height: 4 })
  writeJson(root, 'data/tiles/manifest.json', [])
  writeJson(root, 'data/skills/manifest.json', ['biotic-grenade'])
  writeJson(root, 'data/rules/manifest.json', [])
  writeJson(root, 'data/cards/manifest.json', [])
  writeJson(root, 'data/pieces/manifest.json', ['holder'])
  writeJson(root, 'data/pieces/holder.json', {
    id: 'holder', name: '原棋子', faction: 'good', rarity: 'rare',
    stats: { maxHp: 20, attack: 4, defense: 2, moveRange: 3 },
    skills: [{ skillId: 'biotic-grenade', level: 1 }], rules: ['passive-rule'],
  })
  writeJson(root, 'data/skills/biotic-grenade.json', skill)
  fs.mkdirSync(path.join(root, 'images'), { recursive: true })
  return { root, skill }
}

it('prepares an in-memory draft snapshot with a cloned trial piece and no workspace writes', () => {
  const { root, skill } = fixture()
  fs.writeFileSync(path.join(root, 'images', 'unrelated.gif'), Buffer.from('GIF89a unsupported authoring asset'))
  const before = fs.readFileSync(path.join(root, 'data/skills/biotic-grenade.json'))
  const snapshot = prepareDraftTrainingPreview(root, {
    skillId: 'biotic-grenade',
    drafts: [{ collection: 'skills', document: skill }],
  })
  expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
  expect(snapshot.draft).toMatchObject({ skillId: 'biotic-grenade', pieceId: 'holder', pieceFaction: 'good' })
  expect(snapshot.files.some(file => file.path === 'data/pages/battle.html')).toBe(false)
  expect(snapshot.files.some(file => file.path.includes('users'))).toBe(false)
  expect(snapshot.files.some(file => file.path === 'images/unrelated.gif')).toBe(true)
  const trial = JSON.parse(Buffer.from(snapshot.files.find(file => file.path === `data/pieces/${snapshot.draft.pieceId}.json`)!.bytes).toString())
  expect(trial.id).toBe('holder')
  expect(trial.name).toContain('试用 · ')
  expect(trial.skills).toEqual([{ skillId: 'biotic-grenade', level: 1 }])
  expect(trial.rules).toEqual(['passive-rule'])
  expect(fs.readFileSync(path.join(root, 'data/skills/biotic-grenade.json'))).toEqual(before)
  const bytes = snapshot.files.find(file => file.path === 'data/skills/biotic-grenade.json')!.bytes
  bytes[0] = bytes[0] ^ 0xff
  expect(fs.readFileSync(path.join(root, 'data/skills/biotic-grenade.json'))).toEqual(before)
})

it('derives a deterministic profile identity from the frozen draft bytes', () => {
  const { root, skill } = fixture()
  const request = { skillId: 'biotic-grenade', drafts: [{ collection: 'skills' as const, document: skill }] }
  const first = prepareDraftTrainingPreview(root, request)
  const second = prepareDraftTrainingPreview(root, request)
  const firstIdentity = profileIdentityFromDraftSnapshot(first)
  const secondIdentity = profileIdentityFromDraftSnapshot(second)
  expect(firstIdentity).toEqual(secondIdentity)
  expect(firstIdentity.resolvedProfileHash).toMatch(/^[a-f0-9]{64}$/)
  expect(firstIdentity.authorityContentHash).toMatch(/^[a-f0-9]{64}$/)

  const changedSkill = { ...skill, powerMultiplier: Number(skill.powerMultiplier ?? 1) + 0.5 }
  const changed = prepareDraftTrainingPreview(root, {
    skillId: 'biotic-grenade',
    drafts: [{ collection: 'skills', document: changedSkill }],
  })
  const changedIdentity = profileIdentityFromDraftSnapshot(changed)
  expect(changed.contentHash).not.toBe(first.contentHash)
  expect(changedIdentity.resolvedProfileHash).not.toBe(firstIdentity.resolvedProfileHash)
  expect(changedIdentity.authorityContentHash).not.toBe(firstIdentity.authorityContentHash)
})

it('keeps GIF presentation bytes in the snapshot while covering them through the base hash', () => {
  const { root, skill } = fixture()
  const gif = path.join(root, 'images', 'unrelated.gif')
  fs.writeFileSync(gif, Buffer.from('GIF89a first'))
  const first = prepareDraftTrainingPreview(root, {
    skillId: 'biotic-grenade',
    drafts: [{ collection: 'skills', document: skill }],
  })
  const firstIdentity = profileIdentityFromDraftSnapshot(first)
  expect(first.files.some(file => file.path === 'images/unrelated.gif')).toBe(true)

  fs.writeFileSync(gif, Buffer.from('GIF89a changed'))
  const changed = prepareDraftTrainingPreview(root, {
    skillId: 'biotic-grenade',
    drafts: [{ collection: 'skills', document: skill }],
  })
  const changedIdentity = profileIdentityFromDraftSnapshot(changed)
  expect(changed.contentHash).not.toBe(first.contentHash)
  expect(changedIdentity.resolvedProfileHash).not.toBe(firstIdentity.resolvedProfileHash)
  // GIF is presentation-only and intentionally omitted from the authority
  // JSON projection; the resolved profile hash still changes via base hash.
  expect(changedIdentity.authorityContentHash).toBe(firstIdentity.authorityContentHash)
})

it('keeps the original template id so template-bound rules resolve in the trial', () => {
  const { root, skill } = fixture()
  writeJson(root, 'data/pieces/manifest.json', ['red-shishio'])
  writeJson(root, 'data/pieces/red-shishio.json', {
    id: 'red-shishio', name: '志志雄真实', faction: 'evil', rarity: 'legendary',
    stats: { maxHp: 7, attack: 4, defense: 0, moveRange: 3 },
    skills: [{ skillId: 'biotic-grenade', level: 1 }],
    rules: ['rule-shishio-burn-endturn', 'rule-shishio-burn-move'],
  })
  const snapshot = prepareDraftTrainingPreview(root, {
    skillId: 'biotic-grenade',
    drafts: [{ collection: 'skills', document: skill }],
  })
  expect(snapshot.draft.pieceId).toBe('red-shishio')
  const trial = JSON.parse(Buffer.from(snapshot.files.find(file => file.path === 'data/pieces/red-shishio.json')!.bytes).toString())
  expect(trial.id).toBe('red-shishio')
  expect(trial.rules).toEqual(['rule-shishio-burn-endturn', 'rule-shishio-burn-move'])
  expect(snapshot.files.some(file => file.path.startsWith('data/pieces/editor-trial-'))).toBe(false)
})

it('triggers red-shishio burn rules from a prepared trial template', () => {
  const { root } = fixture()
  const skill = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/skills/shishio-flame-spirit.json'), 'utf8'))
  const piece = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/pieces/red-shishio.json'), 'utf8'))
  writeJson(root, 'data/skills/manifest.json', ['shishio-flame-spirit'])
  writeJson(root, 'data/skills/shishio-flame-spirit.json', skill)
  writeJson(root, 'data/pieces/manifest.json', ['red-shishio'])
  writeJson(root, 'data/pieces/red-shishio.json', piece)
  for (const ruleId of ['rule-shishio-burn-endturn', 'rule-shishio-burn-move']) {
    writeJson(root, `data/rules/${ruleId}.json`, JSON.parse(fs.readFileSync(path.join(process.cwd(), `data/rules/${ruleId}.json`), 'utf8')))
  }
  writeJson(root, 'data/rules/manifest.json', ['rule-shishio-burn-endturn', 'rule-shishio-burn-move'])

  const snapshot = prepareDraftTrainingPreview(root, {
    skillId: 'shishio-flame-spirit',
    drafts: [{ collection: 'skills', document: skill }],
  })
  expect(snapshot.draft.pieceId).toBe('red-shishio')
  const previousRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  try {
    for (const ruleId of ['rule-shishio-burn-endturn', 'rule-shishio-burn-move']) {
      clearRuleCache()
      const shishio = makePiece({ instanceId: 'shishio', templateId: snapshot.draft.pieceId, ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 10, maxHp: 10 })
      const target = makePiece({ instanceId: 'target', templateId: 'target', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 9, maxHp: 9 })
      const state = makeState({ pieces: [shishio, target] })
      state.extensions ??= {}
      state.extensions.shishioBurnTiles = [{ x: target.x, y: target.y, sourcePieceId: shishio.instanceId }]
      const rule = loadRuleById(ruleId, true, true)
      expect(rule).toBeTruthy()
      const context = ruleId.endsWith('endturn')
        ? { type: 'endTurn', playerId: 'player-red', rulePiece: shishio, battle: state }
        : { type: 'afterPiecePositionChange', playerId: 'player-red', rulePiece: shishio, sourcePiece: target, battle: state }
      const result = rule!.effect(state, context)
      expect(result).toMatchObject({ success: true })
      expect(target.currentHp).toBe(5)
    }
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
  }
})

it('requires the root skill draft and a non-empty map manifest', () => {
  const { root, skill } = fixture()
  expect(() => prepareDraftTrainingPreview(root, { skillId: 'biotic-grenade', drafts: [] })).toThrow('根技能草稿')
  writeJson(root, 'data/maps/manifest.json', [])
  expect(() => prepareDraftTrainingPreview(root, { skillId: 'biotic-grenade', drafts: [{ collection: 'skills', document: skill }] })).toThrow('地图资源')
  writeJson(root, 'data/maps/manifest.json', ['missing'])
  expect(() => prepareDraftTrainingPreview(root, { skillId: 'biotic-grenade', drafts: [{ collection: 'skills', document: skill }] })).toThrow('地图文件')
})

it('rejects symlinked authoring ancestors before reading bytes', () => {
  const { root, skill } = fixture()
  const outside = fs.mkdtempSync(path.join(tmpdir(), 'rvb-draft-outside-')); roots.push(outside)
  fs.rmSync(path.join(root, 'images'), { recursive: true, force: true })
  try { fs.symlinkSync(outside, path.join(root, 'images'), 'junction') } catch { return }
  expect(() => prepareDraftTrainingPreview(root, { skillId: 'biotic-grenade', drafts: [{ collection: 'skills', document: skill }] })).toThrow('符号链接')
})

it('rejects prototype-bearing renderer input before filesystem access', () => {
  const { root, skill } = fixture()
  const document = JSON.parse(JSON.stringify(skill))
  Object.defineProperty(document, '__proto__', { value: { polluted: true }, enumerable: true })
  expect(() => prepareDraftTrainingPreview(root, { skillId: 'biotic-grenade', drafts: [{ collection: 'skills', document }] })).toThrow('保留字段')
})
