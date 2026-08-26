import {
  beginBattleAuthorityPersistenceShutdown,
  drainBattleAuthorityPersistenceForShutdown,
} from './battle-authority-persistence'

export const BATTLE_AUTHORITY_SHUTDOWN_REQUEST = 'rvb:battle-authority:shutdown' as const
export const BATTLE_AUTHORITY_SHUTDOWN_RESULT = 'rvb:battle-authority:shutdown-result' as const

export interface BattleAuthorityShutdownRequest {
  type: typeof BATTLE_AUTHORITY_SHUTDOWN_REQUEST
  requestId: string
}

export interface BattleAuthorityShutdownResult {
  type: typeof BATTLE_AUTHORITY_SHUTDOWN_RESULT
  requestId: string
  ok: boolean
  error?: string
}

export interface BattleAuthorityShutdownOptions {
  begin?: () => void
  quiesce?: () => void | Promise<void>
  drain?: () => Promise<void>
  timeoutMs?: number
  processRef?: NodeJS.Process
  exitOnSignal?: boolean
  logger?: Pick<Console, 'log' | 'error'>
}

export async function runBattleAuthorityGracefulShutdown(
  options: Omit<BattleAuthorityShutdownOptions, 'processRef' | 'exitOnSignal'> = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 6_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Battle authority shutdown timeout must be a positive finite number')
  }
  const work = (async () => {
    ;(options.begin ?? beginBattleAuthorityPersistenceShutdown)()
    await options.quiesce?.()
    await (options.drain ?? drainBattleAuthorityPersistenceForShutdown)()
  })()
  await withTimeout(work, timeoutMs)
}

export function installBattleAuthorityShutdownHandlers(
  options: BattleAuthorityShutdownOptions = {},
): () => void {
  const processRef = options.processRef ?? process
  const logger = options.logger ?? console
  const exitOnSignal = options.exitOnSignal ?? true
  let shutdown: Promise<void> | undefined
  const runOnce = () => (shutdown ??= runBattleAuthorityGracefulShutdown(options))

  const onMessage = (message: unknown): void => {
    if (!isShutdownRequest(message)) return
    void runOnce().then(
      async () => {
        await sendResult(processRef, {
          type: BATTLE_AUTHORITY_SHUTDOWN_RESULT,
          requestId: message.requestId,
          ok: true,
        })
      },
      async error => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error('[battle-authority-shutdown] graceful drain failed', { error: errorMessage })
        await sendResult(processRef, {
          type: BATTLE_AUTHORITY_SHUTDOWN_RESULT,
          requestId: message.requestId,
          ok: false,
          error: errorMessage,
        })
      },
    )
  }
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    void runOnce().then(
      () => {
        logger.log('[battle-authority-shutdown] durable journal drained', { signal })
        if (exitOnSignal) processRef.exit(0)
      },
      error => {
        logger.error('[battle-authority-shutdown] exiting with undurable journal', {
          signal,
          error: error instanceof Error ? error.message : String(error),
        })
        if (exitOnSignal) processRef.exit(1)
      },
    )
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')

  processRef.on('message', onMessage)
  processRef.on('SIGINT', onSigint)
  processRef.on('SIGTERM', onSigterm)
  return () => {
    processRef.removeListener('message', onMessage)
    processRef.removeListener('SIGINT', onSigint)
    processRef.removeListener('SIGTERM', onSigterm)
  }
}

function isShutdownRequest(message: unknown): message is BattleAuthorityShutdownRequest {
  return !!message
    && typeof message === 'object'
    && (message as { type?: unknown }).type === BATTLE_AUTHORITY_SHUTDOWN_REQUEST
    && typeof (message as { requestId?: unknown }).requestId === 'string'
    && (message as { requestId: string }).requestId.length > 0
}

function sendResult(processRef: NodeJS.Process, result: BattleAuthorityShutdownResult): Promise<void> {
  if (typeof processRef.send !== 'function' || !processRef.connected) return Promise.resolve()
  return new Promise(resolve => {
    processRef.send!(result, error => {
      if (error) console.error('[battle-authority-shutdown] IPC response failed', error)
      resolve()
    })
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Battle authority graceful shutdown timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timeout.unref?.()
    promise.then(
      value => {
        clearTimeout(timeout)
        resolve(value)
      },
      error => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}
