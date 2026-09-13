import fs from 'node:fs'
import path from 'node:path'
import { ResourceRelease } from './resource-release'
import { runContentPipelineOperationV1 } from '../lib/content-pipeline/tooling'
import type { ContentPipelineOperationV1 } from '../lib/content-pipeline/tooling/contracts'
import { readProfileArchiveV1 } from '../lib/content-pipeline/runtime/profile-archive'
import { resolveProfileV1 } from '../lib/content-pipeline/core/resolver'
import { contentPolicyForChannelV1 } from '../lib/content-pipeline/tooling/archive'

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
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
