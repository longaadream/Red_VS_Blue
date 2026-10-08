import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ACTIVATE = path.join(ROOT, 'scripts/deploy/release-activate.sh')
const PROFILE = path.join(ROOT, 'scripts/deploy/release-profile.mjs')
const PACKAGE_HASH = '25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346'
const NEW_PROFILE = '56211560292d9088c7ec0d1a97e0af86725fb63cd5ed2b16b4a1fd38bd24e3dd'
const NEW_AUTHORITY = 'a46408509276fbb3a96d58bc2a8b6a0b0792775040f8f7ee63375f022c658fd2'
const shell = fs.readFileSync(ACTIVATE, 'utf8')

function indexOfOrFail(source, text) {
  const index = source.indexOf(text)
  assert.notEqual(index, -1, `missing deployment step: ${text}`)
  return index
}

function lastIndexOfOrFail(source, text) {
  const index = source.lastIndexOf(text)
  assert.notEqual(index, -1, `missing deployment step: ${text}`)
  return index
}

function runNode(entry, args, options = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  })
}

function parseSingleJson(result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const lines = result.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 1, 'profile helper stdout must contain one JSON document')
  return JSON.parse(lines[0])
}

test('RED-245 activation keeps all destructive work behind the preflight gates', () => {
  assert.match(shell, /readonly NODE=\/opt\/rvb\/runtime\/node-v24\.21\.0-linux-x64\/bin\/node/)
  assert.match(shell, /readonly GAME_UNIT=rvb-game/)
  assert.match(shell, /readonly OFFICIAL_UNIT=rvb-official/)
  assert.match(shell, /release-0112-4cd7617d8-content-1011/)
  assert.match(shell, new RegExp(PACKAGE_HASH))
  assert.match(shell, /sudo -u rvb -- "\$NODE"/)
  assert.match(shell, /sudo -u postgres pg_dump -Fc "\$DATABASE"/)
  assert.match(shell, /sudo -u postgres psql/)
  assert.match(shell, /readonly GAME_DATABASE=rvb/)
  assert.match(shell, /readonly OFFICIAL_DATABASE=rvb_official/)
  assert.match(shell, /battle_room_authority WHERE terminal IS NOT TRUE/)
  assert.match(shell, /assert_complete_activation_evidence/)
  assert.doesNotMatch(shell, /rvb-relay|nginx|systemctl (?:stop|start).*relay/)

  const maintenance = indexOfOrFail(shell, 'panel_maintenance on')
  const maintenanceProbe = lastIndexOfOrFail(shell, 'probe_both_services "$EXPECTED_OLD_PROFILE" "$OLD_AUTHORITY"')
  const idle = lastIndexOfOrFail(shell, 'assert_db_idle')
  const backup = lastIndexOfOrFail(shell, 'backup_before_stop')
  const cutover = indexOfOrFail(shell, 'CUTOVER_STARTED=1')
  const stop = indexOfOrFail(shell, 'stop_services || die')
  const install = indexOfOrFail(shell, 'profile_install "$GAME_STATE"')
  const link = indexOfOrFail(shell, 'atomic_link_update "$GAME_LINK" "$CANDIDATE_ROOT"')
  const start = indexOfOrFail(shell, 'start_services || die')
  const ready = indexOfOrFail(shell, 'wait_for_services_ready "$EXPECTED_NEW_PROFILE" "$NEW_AUTHORITY"')
  const postcheck = indexOfOrFail(shell, 'probe_both_services "$EXPECTED_NEW_PROFILE" "$NEW_AUTHORITY"')
  assert.ok(maintenance < maintenanceProbe)
  assert.ok(maintenanceProbe < idle)
  assert.ok(idle < backup)
  assert.ok(backup < cutover)
  assert.ok(cutover < stop)
  assert.ok(stop < install)
  assert.ok(install < link)
  assert.ok(link < start)
  assert.ok(start < ready)
  assert.ok(ready < postcheck)

  const rollback = shell.slice(indexOfOrFail(shell, 'rollback_after_failure() {'))
  const rollbackStop = indexOfOrFail(rollback, 'systemctl stop "$GAME_UNIT" "$OFFICIAL_UNIT"')
  const rollbackLinks = indexOfOrFail(rollback, 'restore_old_links')
  const rollbackProfile = indexOfOrFail(rollback, 'profile_rollback')
  const rollbackStart = indexOfOrFail(rollback, 'start_services')
  assert.ok(rollbackStop < rollbackLinks)
  assert.ok(rollbackStop < rollbackProfile)
  assert.ok(rollbackLinks < rollbackStart)
  assert.ok(rollbackProfile < rollbackStart)
  assert.match(shell, /if \[\[ "\$CUTOVER_STARTED" == 1 \]\]; then\s+rollback_after_failure/s)
  assert.match(shell, /restore_maintenance_after_verified_services \|\| printf 'Maintenance remains enabled; pre-cutover cleanup failed/s)
  assert.match(shell, /SERVICES_STOPPED=0/)
})

test('bundled profile helper performs signed install, idempotent install, activation guard, and rollback', async t => {
  const archive = path.join(ROOT, 'output/RED245/resource/content.rvbpack')
  if (!fs.existsSync(archive)) {
    t.skip('RED-245 signed resource fixture is not present')
    return
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'red245-profile-helper-'))
  const bundle = path.join(temporary, 'install-profile.mjs')
  const state = path.join(temporary, 'state')
  fs.mkdirSync(state)
  try {
    await build({
      entryPoints: [PROFILE],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      tsconfig: path.join(ROOT, 'tsconfig.json'),
      logLevel: 'silent',
    })

    const initial = parseSingleJson(runNode(bundle, [
      'inspect', '--app-root', ROOT, '--state-root', state,
    ]))
    const oldProfile = initial.stable.resolvedProfileHash
    assert.match(oldProfile, /^[a-f0-9]{64}$/)
    assert.equal(initial.changed, false)

    const installed = parseSingleJson(runNode(bundle, [
      'install', '--app-root', ROOT, '--state-root', state,
      '--archive', archive, '--expected-stable', oldProfile,
      '--expected-new', NEW_PROFILE, '--expected-package', PACKAGE_HASH,
    ]))
    assert.equal(installed.changed, true)
    assert.equal(installed.stable.resolvedProfileHash, NEW_PROFILE)
    assert.equal(installed.stable.authorityContentHash, NEW_AUTHORITY)
    assert.equal(installed.previousStable.resolvedProfileHash, oldProfile)
    assert.equal(installed.packageHash, PACKAGE_HASH)

    const repeated = parseSingleJson(runNode(bundle, [
      'install', '--app-root', ROOT, '--state-root', state,
      '--archive', archive, '--expected-stable', oldProfile,
      '--expected-new', NEW_PROFILE, '--expected-package', PACKAGE_HASH,
    ]))
    assert.equal(repeated.changed, false)
    assert.equal(repeated.reloadMode, 'already-stable')

    const stateFile = path.join(state, 'resource-pack', 'active.json')
    const interrupted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    interrupted.activation = {
      activationId: 'fixture-activation',
      targetProfileHash: NEW_PROFILE,
      stableProfileHash: NEW_PROFILE,
      requestedAt: new Date(0).toISOString(),
    }
    fs.writeFileSync(stateFile, `${JSON.stringify(interrupted, null, 2)}\n`)
    const refused = runNode(bundle, [
      'inspect', '--app-root', ROOT, '--state-root', state,
    ])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /PROFILE_ACTIVATION_IN_PROGRESS/)
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).activation.activationId, 'fixture-activation')

    const rolledBack = parseSingleJson(runNode(bundle, [
      'rollback', '--app-root', ROOT, '--state-root', state,
      '--expected-stable', NEW_PROFILE, '--expected-previous', oldProfile,
    ]))
    assert.equal(rolledBack.changed, true)
    assert.equal(rolledBack.stable.resolvedProfileHash, oldProfile)
    assert.equal(rolledBack.previousStable.resolvedProfileHash, NEW_PROFILE)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

function writeExecutable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`)
  fs.chmodSync(file, 0o755)
}

function createReleaseFixture(root, { dbResult = '0|0', failOfficial = false } = {}) {
  const bin = path.join(root, 'bin')
  const rvb = path.join(root, 'opt', 'rvb')
  const variable = path.join(root, 'var')
  const gameState = path.join(variable, 'lib', 'rvb')
  const officialState = path.join(variable, 'lib', 'rvb-official')
  const oldId = 'release-0112-4cd7617d8-content-1011'
  const candidateId = 'release-0113-abcdef123-content-1012'
  const commit = 'a'.repeat(40)
  const oldProfile = 'a'.repeat(64)
  const newProfile = 'b'.repeat(64)
  const oldAuthority = 'c'.repeat(64)
  const newAuthority = 'd'.repeat(64)
  const oldRoot = path.join(rvb, 'releases', oldId)
  const candidateRoot = path.join(rvb, 'releases', candidateId)
  const gameLink = path.join(rvb, 'current')
  const officialLink = path.join(rvb, 'official-current')
  const nodeShim = path.join(rvb, 'runtime', 'node-v24.21.0-linux-x64', 'bin', 'node')
  const stateFile = path.join(root, 'mock-state.json')
  const eventsFile = path.join(root, 'events.log')
  const maintenanceFile = path.join(root, 'maintenance')
  const write = (file, value, mode = undefined) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
    if (mode !== undefined) fs.chmodSync(file, mode)
  }
  const state = {
    active: { 'rvb-game': true, 'rvb-official': true },
    node: nodeShim, gameLink, officialLink, oldRoot, candidateRoot,
    oldProfile, newProfile, oldAuthority, newAuthority, eventsFile, failOfficial,
  }
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(oldRoot, 'data'), { recursive: true })
  fs.mkdirSync(candidateRoot, { recursive: true })
  fs.mkdirSync(path.join(gameState, 'resource-pack'), { recursive: true })
  fs.mkdirSync(path.join(officialState, 'resource-pack'), { recursive: true })
  fs.mkdirSync(path.join(variable, 'lock'), { recursive: true })
  write(stateFile, JSON.stringify(state))
  write(maintenanceFile, 'false')
  write(path.join(oldRoot, 'placeholder'), 'old')
  write(path.join(candidateRoot, 'build.json'), JSON.stringify({ dirty: false, sourceHead: commit, nodeMajor: 24 }))
  write(path.join(candidateRoot, 'colyseus-server.mjs'), 'candidate-game')
  write(path.join(candidateRoot, 'official-server.mjs'), 'candidate-official')
  write(path.join(candidateRoot, 'config', 'content-script-publishers.json'), '{}')
  write(path.join(candidateRoot, 'content.rvbpack'), 'fixture-pack')
  write(path.join(candidateRoot, 'install-profile.mjs'), `
import fs from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
const stateRoot = args[args.indexOf('--state-root') + 1]
const marker = stateRoot + '/resource-pack/.fixture-new'
const isOfficial = stateRoot.includes('rvb-official')
const event = name => fs.appendFileSync(process.env.MOCK_EVENTS, name + '\\n')
const oldProfile = ${JSON.stringify(oldProfile)}
const newProfile = ${JSON.stringify(newProfile)}
const oldAuthority = ${JSON.stringify(oldAuthority)}
const newAuthority = ${JSON.stringify(newAuthority)}
const identity = (resolvedProfileHash, authorityContentHash) => ({ kind: 'fixture', resolvedProfileHash, authorityContentHash })
if (command === 'install') { event('install:' + (isOfficial ? 'official' : 'game')); if (isOfficial && process.env.MOCK_FAIL_OFFICIAL === '1') { event('install-failed:official'); process.exit(1) }; fs.writeFileSync(marker, 'new'); process.stdout.write(JSON.stringify({ stable: identity(newProfile, newAuthority), previousStable: identity(oldProfile, oldAuthority) })); process.exit(0) }
if (command === 'rollback') { event('rollback:' + (isOfficial ? 'official' : 'game')); fs.rmSync(marker, { force: true }); process.stdout.write(JSON.stringify({ stable: identity(oldProfile, oldAuthority), previousStable: identity(newProfile, newAuthority) })); process.exit(0) }
const isNew = fs.existsSync(marker)
process.stdout.write(JSON.stringify({ stable: identity(isNew ? newProfile : oldProfile, isNew ? newAuthority : oldAuthority), previousStable: identity(oldProfile, oldAuthority) }))
`)
  const files = [
    'build.json', 'install-profile.mjs', 'colyseus-server.mjs', 'official-server.mjs',
    'config/content-script-publishers.json', 'content.rvbpack',
  ]
  write(path.join(candidateRoot, 'SHA256SUMS'), `${files.map(file => `${cryptoHash(path.join(candidateRoot, file))}  ${file}`).join('\n')}\n`)
  fs.symlinkSync(oldRoot, gameLink, 'dir')
  fs.symlinkSync(oldRoot, officialLink, 'dir')
  write(path.join(officialState, 'control-panel.url'), 'http://127.0.0.1:1/#fixturetoken0123456789012345678901234567890123456789012345678901234567890123\n')
  write(nodeShim, `#!/usr/bin/env bash\nexec ${process.execPath} "$@"\n`, 0o755)
  writeExecutable(path.join(bin, 'systemctl'), `
const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(process.env.MOCK_STATE)); const a = process.argv.slice(2); const unit = a.find(value => value.startsWith('rvb-')); const log = value => fs.appendFileSync(process.env.MOCK_EVENTS, value + '\\n')
if (a[0] === 'show' && a.includes('--property=User')) process.stdout.write('rvb\\n')
else if (a[0] === 'show' && a.includes('--property=Group')) process.stdout.write('rvb\\n')
else if (a[0] === 'show' && a.includes('--property=ExecStart')) process.stdout.write(s.node + ' ' + (unit === 'rvb-game' ? s.gameLink + '/colyseus-server.mjs' : s.officialLink + '/official-server.mjs') + '\\n')
else if (a[0] === 'is-active') process.exit(s.active[unit] ? 0 : 3)
else if (a[0] === 'stop') { for (const name of a.slice(1)) s.active[name] = false; fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(s)); log('systemctl:stop') }
else if (a[0] === 'start') { for (const name of a.slice(1)) s.active[name] = true; fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(s)); log('systemctl:start') }
else process.exit(2)
`)
  writeExecutable(path.join(bin, 'curl'), `
const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(process.env.MOCK_STATE)); const url = process.argv.at(-1); const link = url.includes(':2567/') ? s.gameLink : s.officialLink; const candidate = fs.realpathSync(link) === s.candidateRoot
if (url.endsWith('/healthz')) process.stdout.write(JSON.stringify({ ok: true }))
else if (url.includes('/catalog/identity')) process.stdout.write(JSON.stringify({ profileIdentity: { resolvedProfileHash: candidate ? 'f'.repeat(64) : s.oldProfile, authorityContentHash: candidate ? 'e'.repeat(64) : s.oldAuthority } }))
else if (url.includes('/rooms')) process.stdout.write(JSON.stringify({ rooms: [] }))
else process.exit(1)
`)
  writeExecutable(path.join(bin, 'psql'), `const query = process.argv.join(' '); process.stdout.write((query.includes('battle_room_authority') ? '0' : process.env.MOCK_DB_RESULT) + '\\n')`)
  writeExecutable(path.join(bin, 'pg_dump'), '')
  writeExecutable(path.join(bin, 'stat'), `process.stdout.write('rvb:rvb\\n')`)
  writeExecutable(path.join(bin, 'sleep'), '')
  writeExecutable(path.join(bin, 'sudo'), '')
  const panelStub = [
    'panel_request() {',
    '  local method=$1 endpoint=$2 body=${3:-}',
    '  printf "panel-%s-%s\\n" "$method" "$endpoint" >> "$MOCK_EVENTS"',
    '  if [[ "$method" == POST ]]; then',
    '    if [[ "$body" == *\'"value":"on"\'* ]]; then printf true > "$MOCK_MAINTENANCE"; else printf false > "$MOCK_MAINTENANCE"; fi',
    '    printf \'{"ok":true}\'',
    '  else',
    '    local enabled=false; [[ $(cat "$MOCK_MAINTENANCE") == true ]] && enabled=true',
    '    printf \'{"settings":{"maintenance":%s},"counts":{"active":0,"queued":0}}\' "$enabled"',
    '  fi',
    '}',
  ].join('\n')
  const panelStart = shell.indexOf('panel_request() {')
  const panelEnd = shell.indexOf('\n}\n\npanel_snapshot()', panelStart) + 2
  let script = shell.slice(0, panelStart) + panelStub + shell.slice(panelEnd)
  for (const [from, to] of [
    ['/opt/rvb', '__RVB__'], ['/var/lib/rvb-official', '__OFFICIAL__'],
    ['/var/lib/rvb', '__GAME__'], ['/var/lock', '__LOCK__'], ['/var/backups/rvb', '__BACKUP__'],
  ]) script = script.replaceAll(from, to)
  script = script.replaceAll('__RVB__', rvb).replaceAll('__OFFICIAL__', officialState)
    .replaceAll('__GAME__', gameState).replaceAll('__LOCK__', path.join(variable, 'lock'))
    .replaceAll('__BACKUP__', path.join(variable, 'backups', 'rvb'))
    .replaceAll('sudo -u rvb -- ', '').replaceAll('sudo -u postgres ', '')
  script = script.replace('\nassert_complete_activation_evidence\nbackup_before_stop', '\n: # isolated fixture supplies its own command evidence\nbackup_before_stop')
  const activate = path.join(root, 'release-activate.sh')
  write(activate, script, 0o755)
  return {
    activate, bin, stateFile, eventsFile, maintenanceFile, gameLink, officialLink,
    oldRoot, candidateRoot, gameState, officialState, oldId, candidateId, commit,
    oldProfile, newProfile, oldAuthority, newAuthority, dbResult,
  }
}

function cryptoHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function runFixture(fixture) {
  return spawnSync('bash', [fixture.activate,
    '--release-id', fixture.candidateId, '--previous-release-id', fixture.oldId,
    '--expected-commit', fixture.commit, '--expected-old-profile', fixture.oldProfile,
    '--expected-new-profile', fixture.newProfile, '--database', 'rvb_official',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
      MOCK_STATE: fixture.stateFile,
      MOCK_EVENTS: fixture.eventsFile,
      MOCK_MAINTENANCE: fixture.maintenanceFile,
      MOCK_DB_RESULT: fixture.dbResult,
      MOCK_FAIL_OFFICIAL: fixture.failOfficial ? '1' : '0',
    },
  })
}

test('mock command fixture executes post-start rollback and pre-stop preservation', t => {
  if (process.platform === 'win32') {
    t.skip('the isolated command fixture requires POSIX bash and symlinks')
    return
  }
  const postStartRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'red245-deploy-poststart-'))
  const preStopRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'red245-deploy-prestop-'))
  const partialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'red245-deploy-partial-'))
  try {
    const postStart = createReleaseFixture(postStartRoot)
    const postStartResult = runFixture(postStart)
    assert.notEqual(postStartResult.status, 0)
    const postEvents = fs.readFileSync(postStart.eventsFile, 'utf8').trim().split(/\r?\n/)
    assert.ok(postEvents.indexOf('systemctl:stop') < postEvents.lastIndexOf('systemctl:start'))
    assert.ok(postEvents.lastIndexOf('systemctl:stop') < postEvents.indexOf('rollback:game'))
    assert.ok(postEvents.indexOf('rollback:game') < postEvents.indexOf('systemctl:start'))
    assert.equal(fs.realpathSync(postStart.gameLink), postStart.oldRoot)
    assert.equal(fs.realpathSync(postStart.officialLink), postStart.oldRoot)
    assert.equal(fs.existsSync(path.join(postStart.gameState, 'resource-pack', '.fixture-new')), false)
    assert.equal(fs.readFileSync(postStart.maintenanceFile, 'utf8'), 'false')

    const preStop = createReleaseFixture(preStopRoot, { dbResult: '1|0' })
    const preStopResult = runFixture(preStop)
    assert.notEqual(preStopResult.status, 0)
    const preEvents = fs.existsSync(preStop.eventsFile)
      ? fs.readFileSync(preStop.eventsFile, 'utf8')
      : ''
    assert.doesNotMatch(preEvents, /systemctl:stop/)
    assert.equal(fs.realpathSync(preStop.gameLink), preStop.oldRoot)
    assert.equal(fs.readFileSync(preStop.maintenanceFile, 'utf8'), 'false')

    const partial = createReleaseFixture(partialRoot, { failOfficial: true })
    const partialResult = runFixture(partial)
    assert.notEqual(partialResult.status, 0)
    const partialEvents = fs.readFileSync(partial.eventsFile, 'utf8').trim().split(/\r?\n/)
    assert.ok(partialEvents.includes('install:game'))
    assert.ok(partialEvents.includes('install-failed:official'))
    assert.ok(partialEvents.indexOf('systemctl:stop') < partialEvents.indexOf('rollback:game'))
    assert.equal(fs.existsSync(path.join(partial.gameState, 'resource-pack', '.fixture-new')), false)
    assert.equal(fs.realpathSync(partial.gameLink), partial.oldRoot)
  } finally {
    fs.rmSync(postStartRoot, { recursive: true, force: true })
    fs.rmSync(preStopRoot, { recursive: true, force: true })
    fs.rmSync(partialRoot, { recursive: true, force: true })
  }
})
