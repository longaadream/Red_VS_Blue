import * as fs from 'fs'
import * as path from 'path'
import { isActivatableResourcePackPath } from './resource-pack-store'

export interface ClientProtocolResourceOptions {
  relativePath: string
  htmlRoot: string
  appRoot: string
  activePackRoot: string | null
  isPackaged: boolean
}

export type ClientProtocolRootOptions = Omit<ClientProtocolResourceOptions, 'relativePath'>

const BATTLE_DATA_DIRECTORIES = [
  'cards',
  'maps',
  'pieces',
  'rules',
  'skills',
  'status-effects',
  'tiles',
] as const

const BATTLE_DATA_SINGLETONS = [
  'data/skill-keywords.json',
  'data/tutorial/first-session.json',
] as const

function resolveExistingFile(root: string, segments: readonly string[]): string | null {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...segments)
  const relative = path.relative(resolvedRoot, target)
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return null
  }
  try {
    return fs.statSync(target).isFile() ? target : null
  } catch {
    return null
  }
}

function declaredProfilePaths(activePackRoot: string): Set<string> | null {
  try {
    const metadata = JSON.parse(fs.readFileSync(
      path.join(activePackRoot, '.rvb', 'profile.json'),
      'utf8',
    )) as { files?: Array<{ descriptor?: { path?: unknown } }> }
    if (!Array.isArray(metadata.files)) return null
    const declared = new Set<string>()
    for (const file of metadata.files) {
      if (typeof file.descriptor?.path !== 'string') return null
      declared.add(file.descriptor.path)
    }
    return declared
  } catch {
    return null
  }
}

export function resolveClientProtocolFile({
  relativePath,
  htmlRoot,
  appRoot,
  activePackRoot,
  isPackaged,
}: ClientProtocolResourceOptions): string | null {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0')) {
    return null
  }
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null

  const isPackResource = isActivatableResourcePackPath(relativePath)
  if (isPackResource && activePackRoot) {
    // All data JSON is Profile-owned. Raster paths are Profile-owned only when
    // declared by the immutable inventory; legacy page/public art remains a
    // versioned application asset outside the Profile identity.
    if (relativePath.startsWith('data/')) {
      return resolveExistingFile(activePackRoot, segments)
    }
    const declared = declaredProfilePaths(activePackRoot)
    if (declared === null) return null
    if (declared.has(relativePath)) return resolveExistingFile(activePackRoot, segments)
  }

  if (!isPackaged && relativePath.startsWith('data/')) {
    if (!isPackResource) return null
    const repositoryFile = resolveExistingFile(appRoot, segments)
    if (repositoryFile) return repositoryFile
  }

  const htmlFile = resolveExistingFile(htmlRoot, segments)
  if (htmlFile) return htmlFile

  // Status and tile-effect SVGs are trusted application assets stored outside the
  // staged page root in both development and packaged builds.
  if (/^images\/(?:effect-icons|tile-effects)\/[a-z0-9-]+\.svg$/i.test(relativePath)) {
    return resolveExistingFile(path.join(appRoot, 'public'), segments.slice(1))
  }

  // Development may additionally read legacy raster art from repository public/.
  if (!isPackaged && /^images\/.+\.(?:gif|jpe?g|png|webp)$/i.test(relativePath)) {
    return resolveExistingFile(path.join(appRoot, 'public'), segments.slice(1))
  }

  return null
}

export function readClientProtocolBattleData(
  options: ClientProtocolRootOptions,
  directories: readonly string[] = BATTLE_DATA_DIRECTORIES,
  singletons: readonly string[] = BATTLE_DATA_SINGLETONS,
): Record<string, unknown> {
  const files: Record<string, unknown> = {}
  const readJson = (relativePath: string): unknown => {
    const target = resolveClientProtocolFile({ ...options, relativePath })
    if (!target) throw new Error(`CLIENT_BATTLE_DATA_MISSING: ${relativePath}`)
    try {
      const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'))
      files[relativePath] = value
      return value
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`CLIENT_BATTLE_DATA_INVALID: ${relativePath}: ${reason}`)
    }
  }

  for (const directory of directories) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(directory)) {
      throw new Error(`CLIENT_BATTLE_DATA_DIRECTORY_INVALID: ${directory}`)
    }
    const manifestPath = `data/${directory}/manifest.json`
    const manifest = readJson(manifestPath)
    if (!Array.isArray(manifest)) {
      throw new Error(`CLIENT_BATTLE_DATA_MANIFEST_INVALID: ${manifestPath}`)
    }
    for (const id of manifest) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) {
        throw new Error(`CLIENT_BATTLE_DATA_ID_INVALID: ${manifestPath}`)
      }
      readJson(`data/${directory}/${id}.json`)
    }
  }

  for (const relativePath of singletons) readJson(relativePath)
  return files
}
