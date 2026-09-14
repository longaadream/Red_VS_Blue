import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const skill = JSON.parse(fs.readFileSync(new URL('../../data/skills/blizzard.json', import.meta.url), 'utf8'))

for (const scenario of [
  { name: '边缘施法覆盖全图', piece: { x: 0, y: 0 }, tiles: [{ x: 0, y: 0 }, { x: 20, y: 30 }] },
  { name: '中央施法覆盖超过99格的大地图', piece: { x: 100, y: 100 }, tiles: [{ x: 0, y: 0 }, { x: 250, y: 300 }] },
  { name: '单格地图允许选择自身地格', piece: { x: 0, y: 0 }, tiles: [{ x: 0, y: 0 }] },
]) {
  test(`暴风雪：${scenario.name}`, () => {
    let request
    const pending = { needsTargetSelection: true }
    const execute = vm.runInNewContext(`(${skill.code})`, {
      selectTarget(config) { request = config; return pending },
    })
    const battle = { map: { tiles: scenario.tiles } }
    const before = JSON.stringify(battle)
    assert.equal(execute({ piece: { ...scenario.piece, attack: 7 }, skill, battle }), pending)
    const distances = scenario.tiles.map(tile => Math.abs(tile.x - scenario.piece.x) + Math.abs(tile.y - scenario.piece.y))
    assert.equal(request.range, Math.max(...distances))
    assert.ok(distances.every(distance => distance <= request.range))
    assert.equal(request.type, 'grid')
    assert.equal(request.filter, 'all')
    assert.equal(JSON.stringify(battle), before, '目标选择挂起时不得提前修改战场')
  })
}
