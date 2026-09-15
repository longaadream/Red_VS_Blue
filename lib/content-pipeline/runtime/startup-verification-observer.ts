import { AsyncLocalStorage } from 'node:async_hooks'
import { verificationProgress, type VerificationProgress } from './verification-progress'

const startupObserver = new AsyncLocalStorage<(value: VerificationProgress) => void>()
verificationProgress.subscribe(value => startupObserver.getStore()?.(value))

/** Node-only adapter; each authenticated startup request has its own observer. */
export function withStartupVerification<T>(request: Request, operation: () => Promise<T>): Promise<T> {
  const requestId = request.headers.get('x-rvb-startup-request')
  if (!requestId || !/^[a-f0-9]{32}$/.test(requestId) || !process.connected) return operation()
  let work = 0
  return startupObserver.run(p => {
    if (process.connected) process.send?.({ type: 'rvb:authority:startup-progress', requestId, work: ++work, ...p }, () => {})
  }, operation)
}
