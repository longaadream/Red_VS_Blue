import { PackManifestV1Schema, PackSignatureEnvelopeV1Schema } from '../contracts'
import { parseStrictJsonBytesV1 } from '../core/json-safety'
import { computePackageHashV1 } from '../core/hash'
import { resolveProfileV1, type ResolvePackInputV1 } from '../core/resolver'
import type { ContentPackSourceV1 } from '../core/source'

export interface AndroidPackInput {
  id: string
  source: ContentPackSourceV1
}

/** The native adapter supplies bundled bytes; imported packages can never select this policy. */
export function resolveAndroidProfile(
  bundled: AndroidPackInput,
  chain: AndroidPackInput[],
  trustedKeyIds: readonly string[],
) {
  const compatibility = PackManifestV1Schema.parse(parseStrictJsonBytesV1(bundled.source.manifestBytes)).compatibility
  const inputs: ResolvePackInputV1[] = []
  const sources: Record<string, string> = {}
  const all = chain.length ? chain : [bundled]
  for (const input of all) {
    const manifest = PackManifestV1Schema.parse(parseStrictJsonBytesV1(input.source.manifestBytes))
    const isBundled = input === bundled
    if (!isBundled) {
      if (!input.source.signatureBytes) throw Error('资源包缺少签名')
      const signature = PackSignatureEnvelopeV1Schema.parse(parseStrictJsonBytesV1(input.source.signatureBytes))
      if (!trustedKeyIds.includes(signature.keyId)) throw Error('资源包发行者尚未受信任')
    }
    sources[computePackageHashV1(manifest)] = input.id
    inputs.push({ source: input.source, policy: { kind: isBundled ? 'bundled-base' : 'external', expectedCompatibility: compatibility } })
  }
  const view = resolveProfileV1({ base: inputs[0], patches: inputs.slice(1) })
  return { profile: view.profile, sources, chain: all.map(input => input.id) }
}

export function appendAndroidPack(bundled: AndroidPackInput, parent: AndroidPackInput[], incoming: AndroidPackInput, trustedKeyIds: readonly string[]) {
  const manifest = PackManifestV1Schema.parse(parseStrictJsonBytesV1(incoming.source.manifestBytes))
  return resolveAndroidProfile(bundled, manifest.kind === 'snapshot' ? [incoming] : [...(parent.length ? parent : [bundled]), incoming], trustedKeyIds)
}
