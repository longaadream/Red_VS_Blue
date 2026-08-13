'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LOCK_FILE_NAME = 'red-vs-blue-game-server.lock'
const INCOMPLETE_LOCK_GRACE_MS = 5_000

function defaultServerLockPath() {
  return process.env.RVB_SERVER_LOCK_PATH || path.join(os.tmpdir(), LOCK_FILE_NAME)
}

function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

function removeStaleLock(lockPath) {
  const owner = readOwner(lockPath)
  if (owner && isProcessRunning(owner.pid)) return false

  if (!owner) {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
    if (ageMs < INCOMPLETE_LOCK_GRACE_MS) return false
  }

  try {
    fs.unlinkSync(lockPath)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return true
    return false
  }
}

function acquireServerLock(lockPath = defaultServerLockPath(), owner = 'game-server') {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const token = crypto.randomUUID()
  const payload = JSON.stringify({ pid: process.pid, token, owner, acquiredAt: new Date().toISOString() })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' })
      let released = false
      return {
        path: lockPath,
        release() {
          if (released) return
          released = true
          const current = readOwner(lockPath)
          if (current && current.token === token) {
            try { fs.unlinkSync(lockPath) } catch (error) {
              if (!error || error.code !== 'ENOENT') throw error
            }
          }
        },
      }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      if (attempt === 0 && removeStaleLock(lockPath)) continue
      const current = readOwner(lockPath)
      const details = current
        ? `PID ${current.pid} (${current.owner || 'unknown owner'})`
        : 'an initializing process'
      throw new Error(`RED vs BLUE game server is already running: ${details}`)
    }
  }

  throw new Error('Unable to acquire the RED vs BLUE game server lock')
}

module.exports = { acquireServerLock, defaultServerLockPath }
