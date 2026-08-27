import type { PackFileDescriptorV1 } from '../contracts'

export interface ContentSourceEntryV1 {
  readonly path: string
  readonly bytes: Uint8Array
}

export interface ContentPackSourceV1 {
  readonly manifestBytes: Uint8Array
  readonly signatureBytes?: Uint8Array | null
  readonly entries: readonly ContentSourceEntryV1[]
}

export interface ReadonlyContentTreeV1 {
  readonly files: readonly PackFileDescriptorV1[]
  readFile(path: string): Uint8Array | undefined
  hasExecutableContent(path: string): boolean
}

export interface ResolvedCandidateFileInputV1 {
  readonly descriptor: PackFileDescriptorV1
  readonly bytes: Uint8Array
}

export interface ContentTreeFileInputV1 extends ResolvedCandidateFileInputV1 {
  readonly hasExecutableContent: boolean
}

function cloneDescriptor(
  descriptor: PackFileDescriptorV1,
): PackFileDescriptorV1 {
  return Object.freeze({
    path: descriptor.path,
    mediaType: descriptor.mediaType,
    size: descriptor.size,
    sha256: descriptor.sha256,
  })
}

export function createReadonlyContentTreeV1(
  inputs: readonly ContentTreeFileInputV1[],
): ReadonlyContentTreeV1 {
  const descriptors: PackFileDescriptorV1[] = []
  const bytesByPath = new Map<string, Uint8Array>()
  const executablePaths = new Set<string>()

  for (const input of inputs) {
    const descriptor = cloneDescriptor(input.descriptor)
    descriptors.push(descriptor)
    bytesByPath.set(descriptor.path, new Uint8Array(input.bytes))
    if (input.hasExecutableContent) executablePaths.add(descriptor.path)
  }

  const files = Object.freeze(descriptors)
  return Object.freeze({
    files,
    readFile(path: string): Uint8Array | undefined {
      const stored = bytesByPath.get(path)
      return stored === undefined ? undefined : new Uint8Array(stored)
    },
    hasExecutableContent(path: string): boolean {
      return executablePaths.has(path)
    },
  })
}
