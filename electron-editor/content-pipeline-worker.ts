import { runContentPipelineOperationV1 } from '../lib/content-pipeline/tooling'

const parentPort = process.parentPort
if (!parentPort) throw new Error('CONTENT_WORKER_PARENT_PORT_REQUIRED')

parentPort.on('message', (event) => {
  void runContentPipelineOperationV1(event.data)
    .then(result => parentPort.postMessage({ ok: true, result }))
    .catch(() => parentPort.postMessage({
      ok: false,
      error: 'CONTENT_WORKER_FAILED',
    }))
})
