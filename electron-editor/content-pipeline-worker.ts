import { runContentPipelineOperationV1 } from '../lib/content-pipeline/tooling'
import { importResourceProject } from './content-import-worker'
import { prepareTrainingPreview } from './training-preview-worker'
import { prepareDraftTrainingPreview } from './training-draft-worker'

const parentPort = process.parentPort
if (!parentPort) throw new Error('CONTENT_WORKER_PARENT_PORT_REQUIRED')

parentPort.on('message', (event) => {
  void Promise.resolve().then(async () => event.data?.operation === 'import-project'
    ? importResourceProject(event.data)
    : event.data?.operation === 'prepare-training-preview' ? prepareTrainingPreview(event.data)
    : event.data?.operation === 'prepare-draft-training' ? prepareDraftTrainingPreview(event.data.workspace, event.data.request ?? { skillId: event.data.skillId, drafts: event.data.drafts })
    : runContentPipelineOperationV1(event.data))
    .then(result => parentPort.postMessage({ ok: true, result }))
    .catch((error) => parentPort.postMessage({
      ok: false,
      error: ['import-project', 'prepare-training-preview', 'prepare-draft-training'].includes(event.data?.operation) ? String(error?.message || error).slice(0, 1600) : 'CONTENT_WORKER_FAILED',
    }))
})
