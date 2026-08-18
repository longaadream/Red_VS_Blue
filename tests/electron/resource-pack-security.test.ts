import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, test } from 'vitest'
import {
  RESOURCE_PACK_LIMITS,
  clearActiveResourcePack,
  importResourcePackArchive,
  listActiveResourcePackFiles,
  preflightResourcePackEntries,
  resolveActiveResourcePackRoot,
} from '../../electron-client/resource-pack-store'
import { importResourcePackArchive as importServerResourcePackArchive } from '../../electron/resource-pack-store'

const tempRoots: string[] = []

function tempPackRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red-24-'))
  tempRoots.push(root)
  return root
}

async function zipBuffer(files: Record<string, string | Buffer>, meta?: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  zip.file('pack.json', JSON.stringify(meta ?? {
    name: 'RED-24 test pack',
    version: '1.0.0',
    description: 'security boundary fixture',
    fileCount: Object.keys(files).length,
  }))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Electron resource-pack import boundary', () => {
  test('activates only JSON data and safe raster images from an immutable version', async () => {
    const root = tempPackRoot()
    const archive = await zipBuffer({
      'data/cards/test.json': '{"id":"test"}',
      'images/test.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'index.html': '<script>alert(1)</script>',
      'js/runtime.js': 'alert(1)',
      'images/vector.svg': '<svg onload="alert(1)"/>',
    })

    const result = importResourcePackArchive(root, archive)
    const activeRoot = resolveActiveResourcePackRoot(root)

    expect(result.count).toBe(2)
    expect(activeRoot).toBe(path.join(root, 'versions', result.version))
    expect(fs.readFileSync(path.join(activeRoot!, 'data/cards/test.json'), 'utf8')).toContain('"test"')
    expect(fs.existsSync(path.join(activeRoot!, 'images/test.png'))).toBe(true)
    expect(fs.existsSync(path.join(activeRoot!, 'index.html'))).toBe(false)
    expect(fs.existsSync(path.join(activeRoot!, 'js/runtime.js'))).toBe(false)
    expect(fs.existsSync(path.join(activeRoot!, 'images/vector.svg'))).toBe(false)
    expect(listActiveResourcePackFiles(root)).toEqual([
      '/data/cards/test.json',
      '/images/test.png',
    ])
  })

  test.each([
    ['path traversal', '../data/cards/evil.json'],
    ['absolute POSIX path', '/data/cards/evil.json'],
    ['Windows drive path', 'C:/data/cards/evil.json'],
    ['backslash path', 'data\\cards\\evil.json'],
  ])('rejects %s before writing any version', async (_caseName, unsafeName) => {
    const root = tempPackRoot()
    const archive = await zipBuffer({ [unsafeName]: '{}' })

    expect(() => importResourcePackArchive(root, archive)).toThrow(/path|entry/i)
    expect(fs.existsSync(path.join(root, 'active.json'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'versions'))).toBe(false)
  })

  test('rejects case-insensitive path collisions', async () => {
    const root = tempPackRoot()
    const archive = await zipBuffer({
      'data/cards/Test.json': '{}',
      'data/cards/test.json': '{}',
    })

    expect(() => importResourcePackArchive(root, archive)).toThrow(/duplicate|collision/i)
  })

  test('rejects symlinks and invalid JSON', async () => {
    const symlinkZip = new JSZip()
    symlinkZip.file('data/cards/link.json', 'target', { unixPermissions: 0o120777 })
    symlinkZip.file('pack.json', JSON.stringify({ name: 'symlink', version: '1', fileCount: 1 }))
    const symlinkArchive = await symlinkZip.generateAsync({
      type: 'nodebuffer',
      platform: 'UNIX',
      compression: 'DEFLATE',
    })

    expect(() => importResourcePackArchive(tempPackRoot(), symlinkArchive)).toThrow(/symbolic link/i)
    const invalidJsonArchive = await zipBuffer({ 'data/cards/broken.json': '{' })
    expect(() => importResourcePackArchive(
      tempPackRoot(),
      invalidJsonArchive,
    )).toThrow(/JSON/i)
  })

  test('checks declared entry budgets without decompressing content', () => {
    const entry = (name: string, size: number) => ({
      entryName: name,
      isDirectory: false,
      attr: 0,
      header: { size },
    })

    expect(() => preflightResourcePackEntries([
      entry('data/cards/too-large.json', RESOURCE_PACK_LIMITS.maxFileBytes + 1),
    ])).toThrow(/single file|size/i)

    expect(() => preflightResourcePackEntries(Array.from(
      { length: RESOURCE_PACK_LIMITS.maxEntries + 1 },
      (_, index) => entry(`data/cards/${index}.json`, 1),
    ))).toThrow(/entry count/i)

    const fullBudgetEntries = Array.from(
      { length: RESOURCE_PACK_LIMITS.maxTotalBytes / RESOURCE_PACK_LIMITS.maxFileBytes },
      (_, index) => entry(`data/cards/budget-${index}.json`, RESOURCE_PACK_LIMITS.maxFileBytes),
    )
    expect(() => preflightResourcePackEntries([
      ...fullBudgetEntries,
      entry('data/cards/over-budget.json', 1),
    ])).toThrow(/total/i)
  })

  test('does not change the active pointer when a later import fails', async () => {
    const root = tempPackRoot()
    const first = importResourcePackArchive(root, await zipBuffer({
      'data/cards/first.json': '{"id":"first"}',
    }))
    const invalidJsonArchive = await zipBuffer({
      'data/cards/broken.json': '{',
    })

    expect(() => importResourcePackArchive(root, invalidJsonArchive)).toThrow(/JSON/i)

    expect(resolveActiveResourcePackRoot(root)).toBe(path.join(root, 'versions', first.version))
    expect(listActiveResourcePackFiles(root)).toEqual(['/data/cards/first.json'])
  })

  test('clear resets to built-in resources without deleting retained versions', async () => {
    const root = tempPackRoot()
    const imported = importResourcePackArchive(root, await zipBuffer({
      'data/cards/first.json': '{"id":"first"}',
    }))
    const versionRoot = path.join(root, 'versions', imported.version)

    clearActiveResourcePack(root)

    expect(resolveActiveResourcePackRoot(root)).toBeNull()
    expect(listActiveResourcePackFiles(root)).toEqual([])
    expect(fs.existsSync(versionRoot)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))).toMatchObject({
      version: null,
      previousVersion: imported.version,
    })
  })

  test('preserves rollback history across repeated clear and later activations', async () => {
    const root = tempPackRoot()
    const first = importResourcePackArchive(root, await zipBuffer({
      'data/cards/first.json': '{"id":"first"}',
    }))

    clearActiveResourcePack(root)
    clearActiveResourcePack(root)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))).toMatchObject({
      version: null,
      previousVersion: first.version,
    })

    const secondArchive = await zipBuffer({
      'data/cards/second.json': '{"id":"second"}',
    }, {
      name: 'second pack',
      version: '2.0.0',
      fileCount: 1,
    })
    const second = importResourcePackArchive(root, secondArchive)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))).toMatchObject({
      version: second.version,
      previousVersion: first.version,
    })

    importResourcePackArchive(root, secondArchive)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))).toMatchObject({
      version: second.version,
      previousVersion: first.version,
    })
  })

  test('server desktop import applies the same active-content isolation', async () => {
    const root = tempPackRoot()
    const result = importServerResourcePackArchive(root, await zipBuffer({
      'data/cards/server.json': '{"id":"server"}',
      'index.html': '<script>alert(1)</script>',
    }))
    const versionRoot = path.join(root, 'versions', result.version)

    expect(result.count).toBe(1)
    expect(fs.existsSync(path.join(versionRoot, 'data/cards/server.json'))).toBe(true)
    expect(fs.existsSync(path.join(versionRoot, 'index.html'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8')).version).toBe(result.version)
  })

  test('server activation preserves the previous version recorded by a clear', async () => {
    const root = tempPackRoot()
    const first = importServerResourcePackArchive(root, await zipBuffer({
      'data/cards/server-first.json': '{"id":"server-first"}',
    }))
    fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({
      version: null,
      previousVersion: first.version,
      activatedAt: new Date().toISOString(),
    }))
    const secondArchive = await zipBuffer({
      'data/cards/server-second.json': '{"id":"server-second"}',
    }, {
      name: 'server second pack',
      version: '2.0.0',
      fileCount: 1,
    })
    const second = importServerResourcePackArchive(root, secondArchive)

    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))).toMatchObject({
      version: second.version,
      previousVersion: first.version,
    })
    importServerResourcePackArchive(root, secondArchive)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8')).previousVersion).toBe(first.version)
  })
})
