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

export type ByteSnapshotFailureReasonV1 = 'invalid' | 'budget'

export type ByteSnapshotResultV1 =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; reason: ByteSnapshotFailureReasonV1 }>

const typedArrayPrototypeV1 = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object
const typedArrayTagGetterV1 = Object.getOwnPropertyDescriptor(
  typedArrayPrototypeV1,
  Symbol.toStringTag,
)?.get
const typedArrayBufferGetterV1 = Object.getOwnPropertyDescriptor(
  typedArrayPrototypeV1,
  'buffer',
)?.get
const typedArrayByteLengthGetterV1 = Object.getOwnPropertyDescriptor(
  typedArrayPrototypeV1,
  'byteLength',
)?.get
const arrayBufferByteLengthGetterV1 = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get
const INVALID_BYTE_SNAPSHOT_V1 = Object.freeze({
  ok: false as const,
  reason: 'invalid' as const,
})
const BUDGET_BYTE_SNAPSHOT_V1 = Object.freeze({
  ok: false as const,
  reason: 'budget' as const,
})

/**
 * Captures an ordinary-ArrayBuffer-backed Uint8Array without consulting any
 * replaceable instance getter, iterator, slice method, or cross-realm
 * constructor identity. SharedArrayBuffer, detached views, Proxies, and other
 * ArrayBuffer views fail closed before consumers inspect the bytes.
 *
 * This is an internal core primitive and is intentionally omitted from the
 * public `@/lib/content-pipeline/core` barrel.
 */
export function snapshotOrdinaryUint8ArrayV1(
  value: unknown,
  maxBytes?: number,
): ByteSnapshotResultV1 {
  if (
    typedArrayTagGetterV1 === undefined
    || typedArrayBufferGetterV1 === undefined
    || typedArrayByteLengthGetterV1 === undefined
    || arrayBufferByteLengthGetterV1 === undefined
    || (
      maxBytes !== undefined
      && (
        !Number.isSafeInteger(maxBytes)
        || maxBytes < 0
      )
    )
  ) {
    return INVALID_BYTE_SNAPSHOT_V1
  }

  let tag: unknown
  let backingByteLength: unknown
  let byteLength: unknown
  try {
    tag = typedArrayTagGetterV1.call(value)
    const backingBuffer = typedArrayBufferGetterV1.call(value)
    // The ordinary ArrayBuffer intrinsic rejects SharedArrayBuffer, including
    // cross-realm instances, without relying on replaceable toString tags.
    backingByteLength = arrayBufferByteLengthGetterV1.call(backingBuffer)
    byteLength = typedArrayByteLengthGetterV1.call(value)
  } catch {
    return INVALID_BYTE_SNAPSHOT_V1
  }

  if (
    tag !== 'Uint8Array'
    || typeof backingByteLength !== 'number'
    || !Number.isSafeInteger(backingByteLength)
    || backingByteLength < 0
    || typeof byteLength !== 'number'
    || !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || byteLength > backingByteLength
  ) {
    return INVALID_BYTE_SNAPSHOT_V1
  }
  if (maxBytes !== undefined && byteLength > maxBytes) {
    return BUDGET_BYTE_SNAPSHOT_V1
  }

  let copied: Uint8Array
  try {
    copied = new Uint8Array(value as Uint8Array)
  } catch {
    return INVALID_BYTE_SNAPSHOT_V1
  }
  if (copied.byteLength !== byteLength) {
    return INVALID_BYTE_SNAPSHOT_V1
  }
  return Object.freeze({ ok: true, bytes: copied })
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
    const byteSnapshot = snapshotOrdinaryUint8ArrayV1(input.bytes)
    if (!byteSnapshot.ok) {
      throw new TypeError('Content tree bytes must be an ordinary Uint8Array snapshot')
    }
    descriptors.push(descriptor)
    bytesByPath.set(descriptor.path, byteSnapshot.bytes)
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
