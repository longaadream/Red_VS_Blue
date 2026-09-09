import { runContentPipelineOperationV1 } from '../lib/content-pipeline/tooling'
import { importResourceProject } from './content-import-worker'

const parentPort = process.parentPort
if (!parentPort) throw new Error('CONTENT_WORKER_PARENT_PORT_REQUIRED')

parentPort.on('message', (event) => {
  void Promise.resolve().then(() => event.data?.operation === 'import-project'
    ? importResourceProject(event.data)
    : runContentPipelineOperationV1(event.data))
    .then(result => parentPort.postMessage({ ok: true, result }))
    .catch((error) => parentPort.postMessage({
      ok: false,
      error: event.data?.operation === 'import-project' ? String(error?.message || error).slice(0, 1600) : 'CONTENT_WORKER_FAILED',
    }))
})
