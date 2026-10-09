import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const script = path.join(root, 'scripts/build-official-site.mjs')

function runBuild(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function makeSource({ image = 'fixture.png' } = {}) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-site-source-'))
  writeJson(path.join(source, 'data/pieces/manifest.json'), ['fixture-piece'])
  writeJson(path.join(source, 'data/pieces/fixture-piece.json'), {
    id: 'fixture-piece',
    name: '测试棋子',
    description: '用于官网构建回归测试。',
    faction: 'good',
    image,
    stats: { maxHp: 10, attack: 2, defense: 1, moveRange: 3 }
  })
  writeJson(path.join(source, 'data/skill-keywords.json'), [])
  fs.mkdirSync(path.join(source, 'data/skills'), { recursive: true })
  fs.mkdirSync(path.join(source, 'data/cards'), { recursive: true })
  if (image === 'fixture.png') {
    fs.mkdirSync(path.join(source, 'images'), { recursive: true })
    fs.writeFileSync(path.join(source, 'images/fixture.png'), 'fixture image')
  }
  return source
}

test('requires explicit source and output arguments', () => {
  const result = runBuild()
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--source/)
  assert.match(result.stderr, /--output/)
})

test('builds the requested source and labels the current resource', () => {
  const source = makeSource()
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-site-output-parent-'))
  const destination = path.join(output, 'site')
  try {
    const result = runBuild('--source', source, '--output', destination)
    assert.equal(result.status, 0, result.stderr)
    const atlas = JSON.parse(fs.readFileSync(path.join(destination, 'atlas.json'), 'utf8'))
    assert.equal(atlas.label, '资源 1.0.13 · 配套客户端 0.1.14')
    assert.equal(atlas.pieces[0].description, '用于官网构建回归测试。')
    assert.equal(fs.existsSync(path.join(destination, 'assets/pieces/fixture-piece.png')), true)
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(output, { recursive: true, force: true })
  }
})

test('fails on a missing public piece image without leaving output', () => {
  const source = makeSource({ image: 'missing.png' })
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-site-missing-image-'))
  const destination = path.join(parent, 'site')
  try {
    const result = runBuild('--source', source, '--output', destination)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Missing image for fixture-piece/)
    assert.equal(fs.existsSync(destination), false)
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('refuses to overwrite an existing output directory', () => {
  const source = makeSource()
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-site-existing-'))
  const destination = path.join(parent, 'site')
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, 'marker.txt'), 'keep this output')
  try {
    const result = runBuild('--source', source, '--output', destination)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Refusing to overwrite existing output/)
    assert.equal(fs.readFileSync(path.join(destination, 'marker.txt'), 'utf8'), 'keep this output')
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('website manifest and fallback links point to the current release', () => {
  const release = JSON.parse(fs.readFileSync(path.join(root, 'website/release.json'), 'utf8'))
  const index = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8')
  assert.equal(release.version, '0.1.14')
  assert.equal(release.resource.version, '1.0.13')
  assert.equal(release.resource.minimumClientVersion, '0.1.14')
  assert.equal(release.resource.contentHash, 'cf7d0c22733a652b9e507638374adb28c87af835cb1c502320cf2d1c39117251')
  assert.match(release.resource.url, new RegExp(release.resource.contentHash))
  assert.match(index, /v0\.1\.14\/RED-vs-BLUE-0\.1\.14-Setup\.exe/)
  assert.match(index, /v0\.1\.14\/RED-vs-BLUE-0\.1\.14-Android\.apk/)
  assert.match(index, /公开资源 1\.0\.13 · 最低客户端 0\.1\.14/)
  assert.match(index, /服务器管理与地图池/)
  for (const map of ['双桥裂谷', '四通广场', '群垒庭院', '宽环回廊']) assert.match(index, new RegExp(map))
  assert.match(index, /目标选择、技能与卡牌预演、续选和取消流程/)
})
