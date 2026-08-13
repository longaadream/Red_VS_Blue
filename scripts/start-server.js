'use strict'

const { spawn } = require('child_process')
const path = require('path')
const { acquireServerLock } = require('./server-lock')

const projectRoot = path.resolve(__dirname, '..')
const mode = process.argv[2]
const nextArguments = process.argv.slice(3)
if (mode !== 'dev' && mode !== 'start') {
  console.error('[server] Usage: node scripts/start-server.js <dev|start>')
  process.exit(1)
}

const databaseUrl = process.env.DATABASE_URL ||
  `file:${path.join(projectRoot, 'prisma', 'dev.db').replace(/\\/g, '/')}`

let lock
let init
let server
try {
  lock = acquireServerLock(undefined, `npm run ${mode}`)
} catch (error) {
  console.error('[server]', error.message)
  process.exit(1)
}

function releaseLock() {
  if (!lock) return
  const heldLock = lock
  lock = null
  heldLock.release()
}

init = spawn(process.execPath, [
  path.join(projectRoot, 'scripts', 'init-db.js'),
  databaseUrl,
  path.join(projectRoot, 'node_modules'),
  path.join(projectRoot, 'prisma', 'migrations'),
], { cwd: projectRoot, env: process.env, stdio: 'inherit' })

init.on('error', (error) => {
  console.error('[server] Failed to start database initialization:', error)
  releaseLock()
  process.exitCode = 1
})

init.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`[server] Database initialization failed (${signal || `exit ${code}`}).`)
    releaseLock()
    process.exitCode = code || 1
    return
  }

  const nextBin = require.resolve('next/dist/bin/next')
  server = spawn(process.execPath, [nextBin, mode, ...nextArguments], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })

  const stop = (signal) => {
    if (server && !server.killed) server.kill(signal)
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  server.on('error', (error) => {
    console.error('[server] Failed to start Next.js:', error)
    releaseLock()
    process.exitCode = 1
  })
  server.on('exit', (serverCode, serverSignal) => {
    releaseLock()
    process.exitCode = serverCode ?? (serverSignal ? 1 : 0)
  })
})

process.once('uncaughtException', (error) => {
  console.error('[server] Uncaught exception:', error)
  if (server && !server.killed) server.kill()
  if (init && !init.killed) init.kill()
  releaseLock()
  process.exit(1)
})
process.once('exit', releaseLock)
