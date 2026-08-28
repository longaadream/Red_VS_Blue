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

  // Built-in SVGs are trusted app assets; activatable resource packs remain raster-only.
  if (!isPackaged && /^images\/.+\.(?:gif|jpe?g|png|svg|webp)$/i.test(relativePath)) {
    return resolveExistingFile(path.join(appRoot, 'public'), segments.slice(1))
  }

  return null
}
