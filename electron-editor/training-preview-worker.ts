import fs from 'node:fs'
import path from 'node:path'
import { ResourceRelease } from './resource-release'
import { runContentPipelineOperationV1 } from '../lib/content-pipeline/tooling'
import type { ContentPipelineOperationV1 } from '../lib/content-pipeline/tooling/contracts'
import { readProfileArchiveV1 } from '../lib/content-pipeline/runtime/profile-archive'
import { resolveProfileV1 } from '../lib/content-pipeline/core/resolver'
import { contentPolicyForChannelV1 } from '../lib/content-pipeline/tooling/archive'
import {
  compareUnicodeCodePointsV1,
  type JsonValueV1,
  type PackCapabilityV1,
  type PackFileMediaTypeV1,
  type ResolvedProfileIdentityV1,
} from '../lib/content-pipeline/contracts'
import { deriveFileCapabilitiesV1, sortCapabilitiesV1 } from '../lib/content-pipeline/core/capabilities'
import { computeResolvedProfileIdentitiesV1, sha256HexV1 } from '../lib/content-pipeline/core/hash'
import { PROFILE_CONTENT_ABI_V1, PROFILE_ENGINE_ABI_V1 } from '../lib/content-pipeline/runtime/bundled-base'
import { createGameProfileIdentityV1 } from '../lib/content-pipeline/runtime/profile-game-identity'
import type { TrainingSnapshot } from './training-resources'

function mediaTypeForTrainingPath(relative: string): PackFileMediaTypeV1 {
  if (relative.startsWith('data/') && relative.endsWith('.json')) return 'application/json'
  if (/^images\/(?:[^/]+\/)*[^/]+\.svg$/i.test(relative)) return 'image/svg+xml'
  if (/^images\/(?:[^/]+\/)*[^/]+\.webp$/i.test(relative)) return 'image/webp'
  if (/^images\/(?:[^/]+\/)*[^/]+\.(?:jpg|jpeg)$/i.test(relative)) return 'image/jpeg'
  if (/^images\/(?:[^/]+\/)*[^/]+\.png$/i.test(relative)) return 'image/png'
  throw new Error(`试用资源媒体类型无效：${relative}`)
}

/**
 * Draft training has an intentionally small frozen snapshot rather than a
 * complete installable pack. Build the canonical identity from those exact
 * frozen bytes and a local draft source coordinate; do not reuse the bundled
 * base profile hashes after an authored overlay is applied.
 */
export function profileIdentityFromDraftSnapshot(
  snapshot: Pick<TrainingSnapshot, 'contentHash' | 'files'>,
) {
  const capabilities = new Set<PackCapabilityV1>()
  const files = snapshot.files
    // GIF remains in the frozen training snapshot and is served as an
    // auxiliary presentation asset, but v1 canonical pack descriptors do not
    // have an image/gif media type. Its bytes are still covered by the full
    // snapshot contentHash used as the resolved base package coordinate.
    .filter(file => !/^images\/(?:[^/]+\/)*[^/]+\.gif$/i.test(file.path))
    .slice()
    .sort((left, right) => compareUnicodeCodePointsV1(left.path, right.path))
    .map(file => {
      const mediaType = mediaTypeForTrainingPath(file.path)
      let jsonValue: JsonValueV1 | undefined
      if (mediaType === 'application/json') {
        try { jsonValue = JSON.parse(Buffer.from(file.bytes).toString('utf8')) as JsonValueV1 } catch { /* descriptor hashing remains deterministic */ }
      }
      for (const capability of deriveFileCapabilitiesV1({
        path: file.path,
        mediaType,
        jsonValue,
        hasExecutableContent: false,
      })) capabilities.add(capability)
      return {
        descriptor: {
          path: file.path,
          mediaType,
          size: file.bytes.byteLength,
          sha256: sha256HexV1(file.bytes),
        },
        provenance: {
          packageHash: snapshot.contentHash,
          operation: 'snapshot' as const,
          sourcePath: file.path,
        },
      }
    })
  const identity: ResolvedProfileIdentityV1 = {
    schemaVersion: 'rvb-profile/v1',
    compatibility: {
      engineAbi: PROFILE_ENGINE_ABI_V1,
      contentAbi: PROFILE_CONTENT_ABI_V1,
    },
    capabilities: [...sortCapabilitiesV1(capabilities)],
    base: {
      packageId: 'rvb.editor-training-draft',
      version: '1.0.0',
      packageHash: snapshot.contentHash,
    },
    patches: [],
    files,
  }
  const derived = computeResolvedProfileIdentitiesV1(identity)
  return createGameProfileIdentityV1({
    compatibility: identity.compatibility,
    resolvedProfileHash: derived.resolvedProfileHash,
    authorityContentHash: derived.authorityContentHash,
  })
}

/** Prepare text/bytes only. User scripts execute exclusively in the preview renderer. */
export async function prepareTrainingPreview(input: { workspace: string; appRoot: string; privateRoot: string; taskId: string; acceptedHash: string }) {
  fs.mkdirSync(input.privateRoot, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(input.privateRoot), 'preview-'))
  try {
    const service = new ResourceRelease(input.workspace, input.appRoot, temporary, request => runContentPipelineOperationV1(request as ContentPipelineOperationV1))
    const exported = await service.export(input.taskId, input.acceptedHash, '训练营候选快照')
    const source = readProfileArchiveV1(fs.readFileSync(exported.path))
    const view = resolveProfileV1({ base: { source, policy: contentPolicyForChannelV1('authoring') } })
    return {
      contentHash: exported.contentHash,
      files: view.files.map(file => ({ path: file.path, bytes: view.readFile(file.path)! })),
      profileIdentity: createGameProfileIdentityV1(view.profile),
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
