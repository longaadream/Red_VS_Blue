import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const root = process.cwd()
const standaloneServer = path.join(root, '.next', 'standalone', 'server.js')
const samePortPreload = path.join(root, 'scripts', 'ws-same-port-server.cjs')
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'rvb-red-115-startup-recovery-'))
const probeDatabase = path.join(userDataDir, 'probe.db')
const probeDatabaseUrl = 'file:' + probeDatabase.replaceAll('\\', '/')
const packRoot = path.join(userDataDir, 'resource-pack')
const corruptHash = 'f'.repeat(64)
const corruptAuthorityHash = 'e'.repeat(64)
const corruptRoot = path.join(packRoot, 'profiles', corruptHash)
const adminKey = 'red-115-startup-process-probe'
const corruptReference = {
  schemaVersion: 'rvb-profile-reference/v1',
  kind: 'installed',
  resolvedProfileHash: corruptHash,
  authorityContentHash: corruptAuthorityHash,
  compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
  capabilities: ['game-data'],
  packageId: 'rvb.corrupt-startup',
  version: '1.0.0',
  installedAt: '2026-08-28T00:00:00.000Z',
}

const probePrisma = new PrismaClient({
  datasources: { db: { url: probeDatabaseUrl } },
})
try {
  await probePrisma.$executeRawUnsafe(`
    CREATE TABLE "Room" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'waiting',
      "mapId" TEXT,
      "hostId" TEXT,
      "visibility" TEXT,
      "maxPlayers" INTEGER,
      "players" TEXT NOT NULL DEFAULT '[]',
      "spectators" TEXT NOT NULL DEFAULT '[]',
      "battleState" TEXT,
      "inviteCode" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "version" INTEGER NOT NULL DEFAULT 0,
      "battleAuthorityVersion" INTEGER NOT NULL DEFAULT 0,
      "battleAuthorityTransitionHash" TEXT NOT NULL DEFAULT ''
    )
  `)
} finally {
  await probePrisma.$disconnect()
}
await mkdir(path.join(corruptRoot, '.rvb'), { recursive: true })
await mkdir(path.join(corruptRoot, 'data', 'maps'), { recursive: true })
await writeFile(path.join(corruptRoot, '.rvb', 'profile.json'), '{}')
await writeFile(path.join(corruptRoot, 'data', 'maps', 'corrupt-marker.json'), JSON.stringify({
  id: 'corrupt-marker',
  name: 'must-never-be-authoritative',
  ascii: ['.'],
}))
await writeFile(path.join(packRoot, 'active.json'), JSON.stringify({
  schemaVersion: 'rvb-profile-state/v1',
  revision: 7,
  stable: corruptReference,
  candidate: null,
  previousStable: null,
  activation: null,
  lastFailure: null,
}, null, 2))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert(address && typeof address === 'object')
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

function startServer(port, binding) {
  const child = spawn(process.execPath, ['--require', samePortPreload, standaloneServer], {
    cwd: root,
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      APP_ROOT_DIR: root,
      USER_DATA_DIR: userDataDir,
      DATABASE_URL: probeDatabaseUrl,
      RVB_PROFILE_ADMIN_KEY: adminKey,
      RVB_PROFILE_ADMISSION_PAUSED: 'startup-recovery',
      RVB_PROFILE_ROOT: binding.profileRoot,
      RVB_RESOLVED_PROFILE_HASH: binding.reference?.resolvedProfileHash,
      RVB_AUTHORITY_CONTENT_HASH: binding.reference?.authorityContentHash,
      RVB_PROFILE_ENGINE_ABI: binding.reference?.compatibility.engineAbi,
      RVB_PROFILE_CONTENT_ABI: binding.reference?.compatibility.contentAbi,
      RVB_PROFILE_ACTIVATION_ID: binding.activationId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return { child, output: () => stderr + '\n' + stdout }
}

async function stopServer(server) {
  server.child.kill()
  await new Promise(resolve => {
    if (server.child.exitCode !== null) resolve()
    else server.child.once('exit', resolve)
    setTimeout(resolve, 5_000).unref()
  })
}

async function fetchJson(port, pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, options)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

async function waitForServer(server, port) {
  const deadline = Date.now() + 40_000
  let lastError
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error('standalone server exited ' + server.child.exitCode + '\n' + server.output())
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/ping')
      if (response.status === 200) return
      lastError = new Error('ping returned ' + response.status)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw lastError || new Error('standalone server did not start\n' + server.output())
}

const recoveryRequest = {
  method: 'POST',
  headers: { 'x-rvb-profile-admin-key': adminKey },
}
let corruptServer
let baseServer
let bootstrapServer
try {
  const firstPort = await freePort()
  corruptServer = startServer(firstPort, {
    reference: {
      resolvedProfileHash: corruptHash,
      authorityContentHash: corruptAuthorityHash,
      compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
    },
    profileRoot: corruptRoot,
  })
  await waitForServer(corruptServer, firstPort)
  const gatedBeforeRecovery = await fetchJson(firstPort, '/api/maps')
  assert.equal(gatedBeforeRecovery.status, 503)

  const firstRecovery = await fetchJson(
    firstPort,
    '/api/content-profile/recovery',
    recoveryRequest,
  )
  assert.equal(firstRecovery.status, 200)
  assert.equal(firstRecovery.body.requiresProcessRestart, true)
  assert.equal(firstRecovery.body.previousRuntime.resolvedProfileHash, corruptHash)
  assert.equal(firstRecovery.body.state.stable.kind, 'bundled-base')
  const baseReference = firstRecovery.body.state.stable
  const firstPid = corruptServer.child.pid

  const stillGated = await fetchJson(firstPort, '/api/maps')
  assert.equal(stillGated.status, 503)
  await stopServer(corruptServer)
  corruptServer = undefined

  const secondPort = await freePort()
  baseServer = startServer(secondPort, {
    reference: baseReference,
    profileRoot: root,
  })
  await waitForServer(baseServer, secondPort)
  const secondRecovery = await fetchJson(
    secondPort,
    '/api/content-profile/recovery',
    recoveryRequest,
  )
  assert.equal(secondRecovery.status, 200)
  assert.equal(secondRecovery.body.requiresProcessRestart, false)
  assert.notEqual(baseServer.child.pid, firstPid)

  const report = await fetchJson(secondPort, '/api/content-profile', {
    headers: { 'x-rvb-profile-admin-key': adminKey },
  })
  assert.equal(
    report.status,
    200,
    'post-restart report failed: ' + JSON.stringify(report.body) + '\n' + baseServer.output(),
  )
  assert.equal(report.body.state.stable.resolvedProfileHash, baseReference.resolvedProfileHash)
  assert.equal(report.body.server.profile.resolvedProfileHash, baseReference.resolvedProfileHash)
  assert.equal(report.body.server.activationId, null)
  assert.equal(
    report.body.server.healthy,
    true,
    'post-restart health mismatch: ' + JSON.stringify(report.body.server) + '\n' + baseServer.output(),
  )
  const recoveredProcessPid = baseServer.child.pid

  const maps = await fetchJson(secondPort, '/api/maps')
  assert.equal(maps.status, 200)
  assert.equal(
    maps.body.maps.some(map => map.id === 'corrupt-marker'),
    false,
  )
  const persisted = JSON.parse(await readFile(path.join(packRoot, 'active.json'), 'utf8'))
  assert.equal(persisted.stable.resolvedProfileHash, baseReference.resolvedProfileHash)
  await stopServer(baseServer)
  baseServer = undefined

  await rm(path.join(corruptRoot, '.rvb', 'profile.json'), { force: true })
  await writeFile(path.join(packRoot, 'active.json'), JSON.stringify({
    schemaVersion: 'rvb-profile-state/v1',
    revision: 9,
    stable: corruptReference,
    candidate: null,
    previousStable: null,
    activation: null,
    lastFailure: null,
  }, null, 2))
  process.env.RVB_RESOLVED_PROFILE_HASH = corruptHash
  process.env.RVB_AUTHORITY_CONTENT_HASH = corruptAuthorityHash
  process.env.RVB_PROFILE_ENGINE_ABI = 'ambient-stale-engine'
  process.env.RVB_PROFILE_CONTENT_ABI = 'ambient-stale-content'
  process.env.RVB_PROFILE_ACTIVATION_ID = 'ambient-stale-activation'
  const bootstrapPort = await freePort()
  bootstrapServer = startServer(bootstrapPort, { profileRoot: root })
  await waitForServer(bootstrapServer, bootstrapPort)
  const bootstrapRecovery = await fetchJson(
    bootstrapPort,
    '/api/content-profile/recovery',
    recoveryRequest,
  )
  assert.equal(bootstrapRecovery.status, 200)
  assert.equal(bootstrapRecovery.body.state.stable.kind, 'bundled-base')
  assert.equal(bootstrapRecovery.body.requiresProcessRestart, false)
  const bootstrapReport = await fetchJson(bootstrapPort, '/api/content-profile', {
    headers: { 'x-rvb-profile-admin-key': adminKey },
  })
  assert.equal(bootstrapReport.status, 200)
  assert.equal(
    bootstrapReport.body.server.healthy,
    true,
    'bootstrap health mismatch: ' + JSON.stringify(bootstrapReport.body.server)
      + '\n' + bootstrapServer.output(),
  )
  assert.equal(
    bootstrapReport.body.server.profile.resolvedProfileHash,
    bootstrapRecovery.body.state.stable.resolvedProfileHash,
  )

  console.log(JSON.stringify({
    corruptProcessPid: firstPid,
    recoveredProcessPid,
    initialAdmissionStatus: gatedBeforeRecovery.status,
    recoveryRestartRequired: firstRecovery.body.requiresProcessRestart,
    postRestartHealthy: report.body.server.healthy,
    postRestartProfileHash: report.body.server.profile.resolvedProfileHash,
    corruptMapVisible: maps.body.maps.some(map => map.id === 'corrupt-marker'),
    missingMetadataBootstrapStarted: true,
    ambientStaleIdentityCleared: true,
    missingMetadataRestartRequired: bootstrapRecovery.body.requiresProcessRestart,
    missingMetadataBootstrapHealthy: bootstrapReport.body.server.healthy,
  }, null, 2))
} finally {
  if (corruptServer) await stopServer(corruptServer)
  if (baseServer) await stopServer(baseServer)
  if (bootstrapServer) await stopServer(bootstrapServer)
  await rm(userDataDir, { recursive: true, force: true })
}
