import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  importAssetV1,
  listAssetsV1,
  listPveJsonV1,
  normalizeWorkspaceRelativePathV1,
  prepareWorkspacePackageV1,
  readPveJsonV1,
  validateImageBytesV1,
  validateStaticSvgBytesV1,
  writePveJsonV1,
} from '../../electron-editor/workspace'

const roots: string[] = []
const utf8 = (value: string) => new TextEncoder().encode(value)

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-editor-workspace-'))
  roots.push(root)
  const authoring = path.join(root, 'authoring')
  const project = path.join(root, 'project')
  for (const directory of [
    path.join(authoring, 'data', 'pve', 'campaigns', 'alpha'),
    path.join(authoring, 'images'),
    path.join(authoring, 'sources'),
    path.join(project, 'data', 'pve'),
    path.join(project, 'public', 'images'),
  ]) mkdirSync(directory, { recursive: true })
  return { root, authoring, project }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RED-178 editor workspace safety', () => {
  it('normalizes owned relative paths and rejects traversal and ambiguous separators', () => {
    expect(normalizeWorkspaceRelativePathV1('icons/hero.svg')).toBe('icons/hero.svg')
    for (const value of ['../hero.svg', 'icons/../hero.svg', 'icons\\hero.svg', '/hero.svg']) {
      expect(() => normalizeWorkspaceRelativePathV1(value)).toThrow('EDITOR_WORKSPACE_INVALID')
    }
  })

  it('accepts a strict static SVG subset and rejects active or external content', () => {
    expect(() => validateStaticSvgBytesV1(utf8(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>',
    ))).not.toThrow()
    for (const body of [
      '<script/>', '<path onload="x"/>', '<use href="https://evil.test/x.svg#x"/>',
      '<foreignObject/>', '<path style="fill:url(https://evil.test/x)"/>',
    ]) expect(() => validateStaticSvgBytesV1(utf8(
      `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
    ))).toThrow('EDITOR_WORKSPACE_INVALID')
  })

  it('rejects extension spoofing before an asset enters the workspace', () => {
    expect(() => validateImageBytesV1('fake.png', utf8('<svg/>'))).toThrow('image-signature')
    expect(() => validateImageBytesV1('fake.exe', Uint8Array.of(0x89, 0x50))).toThrow('image-extension')
  })

  it('imports and replaces validated assets without touching unrelated files', () => {
    const { root, authoring } = fixture()
    const first = path.join(root, 'first.svg')
    const second = path.join(root, 'second.svg')
    writeFileSync(first, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
    writeFileSync(second, '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>')
    importAssetV1(authoring, first, 'units/hero.svg', false)
    expect(() => importAssetV1(authoring, second, 'units/hero.svg', false)).toThrow('asset-exists')
    importAssetV1(authoring, second, 'units/hero.svg', true)
    expect(listAssetsV1(authoring).map(file => file.path)).toEqual(['units/hero.svg'])
    expect(readFileSync(path.join(authoring, 'images', 'units', 'hero.svg'), 'utf8')).toContain('<circle')
  })

  it('lists and edits arbitrary-depth PVE JSON without applying a schema', () => {
    const { authoring } = fixture()
    const file = path.join(authoring, 'data', 'pve', 'campaigns', 'alpha', 'node.json')
    writeFileSync(file, '{"custom":{"future":true}}')
    expect(listPveJsonV1(authoring)[0].path).toBe('campaigns/alpha/node.json')
    expect(readPveJsonV1(authoring, 'campaigns/alpha/node.json')).toEqual({ custom: { future: true } })
    writePveJsonV1(authoring, 'campaigns/alpha/node.json', { untouchedShape: [1, 2] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ untouchedShape: [1, 2] })
  })

  it('rebuilds isolated staging and reports added, overwritten, and deleted paths', () => {
    const { authoring, project } = fixture()
    writeFileSync(path.join(project, 'data', 'base.json'), '{"version":1}')
    writeFileSync(path.join(project, 'data', 'pve', 'deleted.json'), '{}')
    writeFileSync(path.join(authoring, 'data', 'base.json'), '{"version":2}')
    writeFileSync(path.join(authoring, 'data', 'added.json'), '{}')
    writeFileSync(path.join(authoring, 'data', 'pve', 'campaigns', 'alpha', 'node.json'), '{}')
    writeFileSync(path.join(authoring, 'images', 'ignored.txt'), 'not published')
    const summary = prepareWorkspacePackageV1(authoring, project)
    expect(summary.source).toBe('sources/current-workspace')
    expect(summary.added).toEqual(['data/added.json', 'data/pve/campaigns/alpha/node.json'])
    expect(summary.overwritten).toEqual(['data/base.json'])
    expect(summary.deleted).toEqual(['data/pve/deleted.json'])
    expect(summary.counts).toEqual({ data: 2, pve: 1, images: 0 })
    expect(readFileSync(path.join(authoring, 'data', 'base.json'), 'utf8')).toBe('{"version":2}')
    expect(() => readFileSync(path.join(authoring, 'sources', 'current-workspace', 'images', 'ignored.txt'))).toThrow()
  })
})
