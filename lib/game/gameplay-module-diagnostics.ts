import { isEffectChainFatalError, isEffectChainPendingSignal } from './effect-batch'
import { isPreviewReactionPendingError } from './rule-runtime'
import { isSuspendableActionPending, SuspendableActionReplayError } from './suspendable-action-transaction'
import { isAuthorChoiceCancelled } from './author-choice-runtime'

/** Ephemeral property used to connect generated v2 modules to their host. */
export const GAMEPLAY_MODULE_DIAGNOSTIC_HOST_KEY = '__gameplayModuleDiagnosticHost' as const

export type GameplayModuleDiagnostic = {
  readonly statementId: string
  readonly moduleId?: string
  readonly message: string
  readonly errorName?: string
  readonly surface?: string
  readonly contentId?: string
  readonly actorPlayerId?: string
  readonly turn?: number
  readonly phase?: string
  readonly rootSeed?: number
  readonly actionId?: string
  readonly chainId?: string
}

export type GameplayModuleDiagnosticMetadata = Omit<GameplayModuleDiagnostic, 'statementId' | 'message' | 'errorName'>
export type GameplayModuleDiagnosticSink = (diagnostic: GameplayModuleDiagnostic) => void

export type GameplayModuleDiagnosticHost = {
  readonly diagnostics: GameplayModuleDiagnostic[]
  readonly suppressedCount: number
  readonly record: (statementId: string, error: unknown, moduleId?: string) => void
  readonly shouldRethrow: (error: unknown) => boolean
}

function errorName(error: unknown): string | undefined {
  try {
    return error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : undefined
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name
  } catch {
    // Hostile thrown values can trap prototype/message inspection. Continue
    // with the non-reflective fallbacks below so reporting never escapes.
  }
  try {
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message
  } catch {
    // Keep diagnostics total for hostile Proxy values.
  }
  if (typeof error === 'string') return error
  return 'Unknown gameplay module failure'
}

/** Control signals must leave a statement boundary unchanged. */
export function isGameplayModuleControlSignal(error: unknown): boolean {
  try {
    if (isAuthorChoiceCancelled(error)) return true
    if (isEffectChainFatalError(error)) return true
  } catch {
    // A hostile Proxy may trap prototype inspection; classify it as ordinary
    // content failure and let the attached transaction wrap it as fatal.
  }
  try {
    if (isEffectChainPendingSignal(error) || isSuspendableActionPending(error)) return true
  } catch {
    // Preserve the same fail-closed behavior for hostile pending lookalikes.
  }
  try {
    if (error instanceof SuspendableActionReplayError) return true
  } catch {
    // Hostile prototype trap; this is not evidence of a replay control signal.
  }
  try {
    if (isPreviewReactionPendingError(error)) return true
  } catch {
    // Preview classifiers are also kept outside authored control flow.
  }
  if (errorName(error) === 'SuspendableActionReplayError') return true
  try {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'SUSPENDABLE_ACTION_REPLAY_MISMATCH')
  } catch {
    return false
  }
}

export function createGameplayModuleDiagnosticHost(surface?: string, metadata: Omit<GameplayModuleDiagnosticMetadata, 'surface'> = {}, sink?: GameplayModuleDiagnosticSink): GameplayModuleDiagnosticHost {
  const diagnostics: GameplayModuleDiagnostic[] = []
  let suppressedCount = 0
  return {
    diagnostics,
    get suppressedCount() { return suppressedCount },
    record(statementId, error, moduleId) {
      if (diagnostics.length >= 64) {
        suppressedCount += 1
        if (diagnostics.length === 64) {
          const summary = Object.freeze({
            statementId: '__gameplayModuleDiagnosticSummary',
            message: 'Further gameplay module diagnostics were suppressed after the per-execution limit',
            ...(surface ? { surface } : {}),
            ...metadata,
          })
          diagnostics.push(summary)
          try {
            (sink ?? ((value: GameplayModuleDiagnostic) => console.error('[gameplay-module-diagnostic]', value)))(summary)
          } catch {
            // Reporting must never change the action's control flow.
          }
        }
        return
      }
      const diagnostic = Object.freeze({
        statementId,
        ...(moduleId ? { moduleId } : {}),
        message: errorMessage(error),
        ...(errorName(error) ? { errorName: errorName(error) } : {}),
        ...(surface ? { surface } : {}),
        ...metadata,
      })
      diagnostics.push(diagnostic)
      try {
        (sink ?? ((value: GameplayModuleDiagnostic) => console.error('[gameplay-module-diagnostic]', value)))(diagnostic)
      } catch {
        // Reporting must never change the action's control flow.
      }
    },
    shouldRethrow(error) { return isGameplayModuleControlSignal(error) },
  }
}

export function installGameplayModuleDiagnosticHost(context: object, host: GameplayModuleDiagnosticHost): () => void {
  const prior = Object.getOwnPropertyDescriptor(context, GAMEPLAY_MODULE_DIAGNOSTIC_HOST_KEY)
  try {
    Object.defineProperty(context, GAMEPLAY_MODULE_DIAGNOSTIC_HOST_KEY, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: host,
    })
  } catch {
    // A frozen host context cannot carry diagnostics. Generated v2 code will
    // rethrow ordinary failures when no host is present.
    return () => undefined
  }
  return () => {
    try {
      if (prior) Object.defineProperty(context, GAMEPLAY_MODULE_DIAGNOSTIC_HOST_KEY, prior)
      else delete (context as Record<string, unknown>)[GAMEPLAY_MODULE_DIAGNOSTIC_HOST_KEY]
    } catch {
      // Diagnostic cleanup must never alter the result of the game action.
    }
  }
}
