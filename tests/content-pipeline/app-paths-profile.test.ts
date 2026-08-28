import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { getDataRoot } from '@/lib/app-paths'

const roots: string[] = []
const originalEnvironment = {
  APP_ROOT_DIR: process.env.APP_ROOT_DIR,
  USER_DATA_DIR: process.env.USER_DATA_DIR,
  RVB_PROFILE_ROOT: process.env.RVB_PROFILE_ROOT,
}

function temporaryRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red-115-paths-'))
  roots.push(root)
  const appRoot = path.join(root, 'app')
  const userData = path.join(root, 'user')
  fs.mkdirSync(path.join(appRoot, 'data'), { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(appRoot, 'data', 'base.json'), '{}')
  process.env.APP_ROOT_DIR = appRoot
  process.env.USER_DATA_DIR = userData
  delete process.env.RVB_PROFILE_ROOT
  return { appRoot, userData }
}

function restore(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore('APP_ROOT_DIR')
  restore('USER_DATA_DIR')
  restore('RVB_PROFILE_ROOT')
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('RED-115 authoritative Profile data root', () => {
  test('uses bundled Base when no v1 stable pointer exists', () => {
    const { appRoot } = temporaryRuntime()
    expect(getDataRoot()).toBe(path.join(appRoot, 'data'))
  })

  test('uses one complete installed stable snapshot', () => {
    const { userData } = temporaryRuntime()
    const hash = 'a'.repeat(64)
    const profileRoot = path.join(userData, 'resource-pack', 'profiles', hash)
    fs.mkdirSync(path.join(profileRoot, '.rvb'), { recursive: true })
    fs.mkdirSync(path.join(profileRoot, 'data'), { recursive: true })
    fs.writeFileSync(path.join(profileRoot, '.rvb', 'profile.json'), '{}')
    fs.writeFileSync(path.join(userData, 'resource-pack', 'active.json'), JSON.stringify({
      schemaVersion: 'rvb-profile-state/v1',
      stable: { kind: 'installed', resolvedProfileHash: hash },
    }))

    expect(getDataRoot()).toBe(path.join(profileRoot, 'data'))
  })

  test('fails closed instead of mixing Base when installed stable is incomplete', () => {
    const { userData } = temporaryRuntime()
    const hash = 'b'.repeat(64)
    fs.mkdirSync(path.join(userData, 'resource-pack'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'resource-pack', 'active.json'), JSON.stringify({
      schemaVersion: 'rvb-profile-state/v1',
      stable: { kind: 'installed', resolvedProfileHash: hash },
    }))

    expect(() => getDataRoot()).toThrow(/PROFILE_SNAPSHOT_INCOMPLETE/)
  })

  test('an explicit candidate root is authoritative and never falls through', () => {
    const { appRoot } = temporaryRuntime()
    const candidateRoot = path.join(path.dirname(appRoot), 'candidate')
    process.env.RVB_PROFILE_ROOT = candidateRoot

    expect(() => getDataRoot()).toThrow(/PROFILE_SNAPSHOT_INCOMPLETE/)
  })
})
