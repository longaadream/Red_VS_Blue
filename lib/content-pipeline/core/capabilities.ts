import type {
  JsonValueV1,
  PackCapabilityV1,
  PackFileMediaTypeV1,
} from '../contracts'
import { compareUnicodeCodePointsV1 } from '../contracts'

export const PVE_SCHEMA_VERSIONS_V1 = Object.freeze([
  'rvb-pve-content-manifest/v1',
  'rvb-pve-campaign/v1',
  'rvb-pve-chapter/v1',
  'rvb-pve-encounter/v1',
  'rvb-pve-event/v1',
  'rvb-pve-reward/v1',
  'rvb-pve-relic/v1',
  'rvb-pve-enemy-setup/v1',
  'rvb-pve-node/v1',
] as const)

const pveSchemaVersions = new Set<string>(PVE_SCHEMA_VERSIONS_V1)

function schemaVersionOf(value: JsonValueV1 | undefined): string | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined
  if (typeof value !== 'object') return undefined
  const schemaVersion = value.schemaVersion
  return typeof schemaVersion === 'string' ? schemaVersion : undefined
}

export function isPveJsonContentV1(
  path: string,
  value: JsonValueV1 | undefined,
): boolean {
  const schemaVersion = schemaVersionOf(value)
  return path.startsWith('data/pve/')
    || (schemaVersion !== undefined && pveSchemaVersions.has(schemaVersion))
}

export function deriveFileCapabilitiesV1(input: {
  readonly path: string
  readonly mediaType: PackFileMediaTypeV1
  readonly jsonValue?: JsonValueV1
  readonly hasExecutableContent: boolean
}): readonly PackCapabilityV1[] {
  const result = new Set<PackCapabilityV1>()
  if (input.mediaType === 'application/json') {
    result.add(isPveJsonContentV1(input.path, input.jsonValue)
      ? 'pve-content'
      : 'game-data')
  } else {
    result.add('raster-assets')
  }
  if (input.hasExecutableContent) result.add('trusted-executable-content')
  return sortCapabilitiesV1(result)
}

export function sortCapabilitiesV1(
  capabilities: Iterable<PackCapabilityV1>,
): readonly PackCapabilityV1[] {
  return Object.freeze(
    [...new Set(capabilities)].sort(compareUnicodeCodePointsV1),
  )
}

export function sameCapabilitiesV1(
  left: readonly PackCapabilityV1[],
  right: readonly PackCapabilityV1[],
): boolean {
  return left.length === right.length
    && left.every((capability, index) => capability === right[index])
}
