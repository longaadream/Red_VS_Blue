import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const MAX_ASSET_BYTES = 10 * 1024 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.svg', '.webp'])
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'path', 'rect', 'circle',
  'ellipse', 'line', 'polyline', 'polygon', 'clipPath', 'mask', 'linearGradient',
  'radialGradient', 'stop',
])
const SVG_ATTRIBUTES = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx',
  'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
  'opacity', 'transform', 'id', 'href', 'clip-path', 'mask', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'preserveAspectRatio',
])

export interface WorkspaceFileV1 {
  readonly path: string
  readonly size: number
}

export interface WorkspaceDiffV1 {
  readonly added: readonly string[]
  readonly overwritten: readonly string[]
  readonly deleted: readonly string[]
  readonly counts: Readonly<{ data: number; pve: number; images: number }>
  readonly capabilities: readonly string[]
}

function fail(message: string): never {
  throw new Error(`EDITOR_WORKSPACE_INVALID: ${message}`)
}

export function normalizeWorkspaceRelativePathV1(value: string, extension?: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) fail('path')
  const normalized = value.split('/').filter(Boolean)
  if (normalized.length === 0 || normalized.some(segment => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    fail('path')
  }
  const relative = normalized.join('/')
  if (extension && path.posix.extname(relative).toLowerCase() !== extension) fail('extension')
  return relative
}

function within(root: string, relative: string): string {
  const absoluteRoot = path.resolve(root)
  if (existsSync(absoluteRoot) && lstatSync(absoluteRoot).isSymbolicLink()) fail('root-symbolic-link')
  const absolute = path.resolve(absoluteRoot, ...relative.split('/'))
  if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) fail('path')
  let cursor = absoluteRoot
  for (const segment of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('symbolic-link')
  }
  return absolute
}

function walk(root: string, directory = root): WorkspaceFileV1[] {
  if (!existsSync(directory)) return []
  if (lstatSync(root).isSymbolicLink()) fail('root-symbolic-link')
  const result: WorkspaceFileV1[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) fail('symbolic-link')
    if (entry.isDirectory()) result.push(...walk(root, absolute))
    else if (entry.isFile()) result.push({
      path: path.relative(root, absolute).split(path.sep).join('/'),
      size: lstatSync(absolute).size,
    })
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export function listPveJsonV1(authoringRoot: string): WorkspaceFileV1[] {
  const root = path.join(authoringRoot, 'data', 'pve')
  return walk(root).filter(file => file.path.toLowerCase().endsWith('.json'))
}

export function readPveJsonV1(authoringRoot: string, relativePath: string): unknown {
  const relative = normalizeWorkspaceRelativePathV1(relativePath, '.json')
  return JSON.parse(readFileSync(within(path.join(authoringRoot, 'data', 'pve'), relative), 'utf8'))
}

export function writePveJsonV1(authoringRoot: string, relativePath: string, value: unknown): void {
  const relative = normalizeWorkspaceRelativePathV1(relativePath, '.json')
  const target = within(path.join(authoringRoot, 'data', 'pve'), relative)
  if (!existsSync(target)) fail('pve-file-not-found')
  JSON.stringify(value)
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}

export function validateStaticSvgBytesV1(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) fail('svg-size')
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail('svg-utf8')
  }
  source = source.replace(/^\uFEFF?\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>\s*/i, '')
  if (/\u0000|<!DOCTYPE|<!ENTITY|<\?|<!--|<!\[CDATA\[/i.test(source)) fail('svg-active-markup')
  if (/\b(?:style|class)\s*=|\burl\s*\((?!\s*#[A-Za-z][\w.-]*\s*\))/i.test(source)) fail('svg-css')
  if (/\b(?:javascript|data|file):/i.test(source)) fail('svg-external-reference')

  let cursor = 0
  let rootSeen = false
  const elementStack: string[] = []
  const tagPattern = /<\s*(\/)?\s*([A-Za-z][A-Za-z0-9]*)\b([^<>]*?)(\/)?\s*>/g
  for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
    const between = source.slice(cursor, match.index)
    if (/[<>]/.test(between)) fail('svg-markup')
    if (elementStack.length === 0 && between.trim()) fail('svg-root-text')
    cursor = tagPattern.lastIndex
    const closing = Boolean(match[1])
    const tag = match[2]
    if (!SVG_ELEMENTS.has(tag)) fail(`svg-element-${tag}`)
    if (!rootSeen) {
      if (closing || tag !== 'svg') fail('svg-root')
      rootSeen = true
    } else if (!closing && elementStack.length === 0) fail('svg-multiple-roots')
    if (closing) {
      if (match[3].trim() || match[4]) fail('svg-closing-tag')
      if (elementStack.pop() !== tag) fail('svg-unbalanced')
      continue
    }
    const attributes = match[3]
    let attributeCursor = 0
    const attributeNames = new Set<string>()
    const attributePattern = /\s+([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(["'])(.*?)\2/gs
    for (let attribute = attributePattern.exec(attributes); attribute; attribute = attributePattern.exec(attributes)) {
      if (attributes.slice(attributeCursor, attribute.index).trim()) fail('svg-attribute-syntax')
      attributeCursor = attributePattern.lastIndex
      const name = attribute[1]
      const value = attribute[3]
      if (attributeNames.has(name)) fail('svg-duplicate-attribute')
      attributeNames.add(name)
      if (name.toLowerCase().startsWith('on') || !SVG_ATTRIBUTES.has(name)) fail(`svg-attribute-${name}`)
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') fail('svg-namespace')
      if (name === 'href' && !/^#[A-Za-z][\w.-]*$/.test(value)) fail('svg-href')
      if (name !== 'xmlns' && /\bhttps?:|\/\//i.test(value)) fail('svg-external-reference')
      if (/[<>`]/.test(value) || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) fail('svg-attribute-value')
    }
    if (attributes.slice(attributeCursor).trim()) fail('svg-attribute-syntax')
    if (!match[4]) elementStack.push(tag)
  }
  if (!rootSeen || elementStack.length > 0 || source.slice(cursor).trim()) fail('svg-markup')
}

export function validateImageBytesV1(filename: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) fail('image-size')
  const extension = path.extname(filename).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) fail('image-extension')
  if (extension === '.svg') return validateStaticSvgBytesV1(bytes)
  if (extension === '.png' && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return
  if ((extension === '.jpg' || extension === '.jpeg') && hasPrefix(bytes, [0xff, 0xd8, 0xff])) return
  if (extension === '.webp' && bytes.byteLength >= 12 && hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])) return
  fail('image-signature')
}

export function listAssetsV1(authoringRoot: string): WorkspaceFileV1[] {
  return walk(path.join(authoringRoot, 'images')).filter(file => IMAGE_EXTENSIONS.has(path.extname(file.path).toLowerCase()))
}

export function readAssetDataUrlV1(authoringRoot: string, relativePath: string): string {
  const relative = normalizeWorkspaceRelativePathV1(relativePath)
  const bytes = new Uint8Array(readFileSync(within(path.join(authoringRoot, 'images'), relative)))
  validateImageBytesV1(relative, bytes)
  const mime = ({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.webp': 'image/webp',
  } as Record<string, string>)[path.extname(relative).toLowerCase()]
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

export function importAssetV1(
  authoringRoot: string,
  sourcePath: string,
  destinationPath: string,
  replace: boolean,
): WorkspaceFileV1 {
  const stat = lstatSync(sourcePath)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('asset-source')
  const destination = normalizeWorkspaceRelativePathV1(destinationPath)
  const sourceExtension = path.extname(sourcePath).toLowerCase()
  if (path.extname(destination).toLowerCase() !== sourceExtension) fail('asset-extension-mismatch')
  const bytes = new Uint8Array(readFileSync(sourcePath))
  validateImageBytesV1(destination, bytes)
  const target = within(path.join(authoringRoot, 'images'), destination)
  if (existsSync(target) && !replace) fail('asset-exists')
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.bak`)
  let movedOriginal = false
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' })
    if (replace && existsSync(target)) {
      renameSync(target, backup)
      movedOriginal = true
    }
    renameSync(temporary, target)
    if (movedOriginal) rmSync(backup, { force: true })
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
    if (movedOriginal && !existsSync(target) && existsSync(backup)) renameSync(backup, target)
    throw error
  }
  return { path: destination, size: bytes.byteLength }
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function copyPublishableTree(sourceRoot: string, destinationRoot: string, kind: 'data' | 'images'): void {
  for (const file of walk(sourceRoot)) {
    const extension = path.extname(file.path).toLowerCase()
    if (kind === 'data' && extension !== '.json') continue
    if (kind === 'images' && !IMAGE_EXTENSIONS.has(extension)) continue
    const source = within(sourceRoot, normalizeWorkspaceRelativePathV1(file.path))
    const bytes = new Uint8Array(readFileSync(source))
    if (kind === 'data') JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    else validateImageBytesV1(file.path, bytes)
    const target = within(destinationRoot, normalizeWorkspaceRelativePathV1(file.path))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx' })
  }
}

function diffTrees(authoringRoot: string, projectRoot: string): WorkspaceDiffV1 {
  const workspaceFiles = [
    ...walk(path.join(authoringRoot, 'data')).map(file => ({ ...file, path: `data/${file.path}` })),
    ...walk(path.join(authoringRoot, 'images')).map(file => ({ ...file, path: `images/${file.path}` })),
  ].filter(file => file.path.endsWith('.json') || IMAGE_EXTENSIONS.has(path.extname(file.path).toLowerCase()))
  const baselineFiles = [
    ...walk(path.join(projectRoot, 'data')).map(file => ({ ...file, path: `data/${file.path}` })),
    ...walk(path.join(projectRoot, 'public', 'images')).map(file => ({ ...file, path: `images/${file.path}` })),
  ].filter(file => file.path.endsWith('.json') || IMAGE_EXTENSIONS.has(path.extname(file.path).toLowerCase()))
  const workspace = new Map(workspaceFiles.map(file => [file.path, file]))
  const baseline = new Map(baselineFiles.map(file => [file.path, file]))
  const added: string[] = []
  const overwritten: string[] = []
  const deleted: string[] = []
  for (const file of workspaceFiles) {
    const original = baseline.get(file.path)
    if (!original) added.push(file.path)
    else if (digest(within(authoringRoot, file.path)) !== digest(file.path.startsWith('data/')
      ? within(projectRoot, file.path)
      : within(path.join(projectRoot, 'public'), file.path))) overwritten.push(file.path)
  }
  for (const file of baselineFiles) if (!workspace.has(file.path)) deleted.push(file.path)
  return {
    added,
    overwritten,
    deleted,
    counts: {
      data: workspaceFiles.filter(file => file.path.startsWith('data/') && !file.path.startsWith('data/pve/')).length,
      pve: workspaceFiles.filter(file => file.path.startsWith('data/pve/')).length,
      images: workspaceFiles.filter(file => file.path.startsWith('images/')).length,
    },
    capabilities: [
      ...(workspaceFiles.some(file => file.path.startsWith('data/')) ? ['game-data'] : []),
      ...(workspaceFiles.some(file => file.path.startsWith('data/pve/')) ? ['pve-content'] : []),
      ...(workspaceFiles.some(file => file.path.startsWith('images/')) ? ['raster-assets'] : []),
      ...(workspaceFiles.some(file => file.path.endsWith('.json') && /"(?:code|skillCode|triggerSkill|previewCode|effectCode)"\s*:/.test(
        readFileSync(within(authoringRoot, file.path), 'utf8'),
      )) ? ['trusted-executable-content'] : []),
    ].sort(),
  }
}

export function prepareWorkspacePackageV1(authoringRoot: string, projectRoot: string): WorkspaceDiffV1 & { source: string } {
  const sourcesRoot = path.join(authoringRoot, 'sources')
  const target = path.join(sourcesRoot, 'current-workspace')
  const temporary = path.join(sourcesRoot, `.current-workspace-${process.pid}-${Date.now()}`)
  if (lstatSync(sourcesRoot).isSymbolicLink()) fail('sources-symbolic-link')
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) fail('staging-symbolic-link')
  mkdirSync(temporary, { recursive: true })
  try {
    copyPublishableTree(path.join(authoringRoot, 'data'), path.join(temporary, 'data'), 'data')
    const images = path.join(authoringRoot, 'images')
    if (existsSync(images)) copyPublishableTree(images, path.join(temporary, 'images'), 'images')
    const summary = diffTrees(authoringRoot, projectRoot)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(temporary, target)
    return { source: 'sources/current-workspace', ...summary }
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}
