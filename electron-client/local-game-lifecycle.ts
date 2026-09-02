export const LOCAL_GAME_OPEN_CANCELLED = 'LOCAL_GAME_OPEN_CANCELLED'
export const LOCAL_GAME_SHUTDOWN_IN_PROGRESS = 'LOCAL_GAME_SHUTDOWN_IN_PROGRESS'

export type LocalAuthorityRecoverySnapshot = Readonly<{
  attempts: number
  maxAttempts: number
  blocked: boolean
}>

export class LocalAuthorityRecoveryBudget {
  private attempts = 0
  private blocked = false

  constructor(private readonly maxAttempts: number) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('LOCAL_AUTHORITY_RECOVERY_MAX_ATTEMPTS_INVALID')
    }
  }

  claimAttempt(): { attempt: number; maxAttempts: number } | null {
    if (this.blocked || this.attempts >= this.maxAttempts) {
      this.blocked = true
      return null
    }
    this.attempts += 1
    return { attempt: this.attempts, maxAttempts: this.maxAttempts }
  }

  recordFailure(): void {
    if (this.attempts >= this.maxAttempts) this.blocked = true
  }

  recordSuccess(): void {
    this.attempts = 0
    this.blocked = false
  }

  rearm(): void {
    this.attempts = 0
    this.blocked = false
  }

  snapshot(): LocalAuthorityRecoverySnapshot {
    return {
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      blocked: this.blocked,
    }
  }
}

export class LocalGameLifecycleGate {
  private generation = 0
  private shutdownDepth = 0

  beginOpening(): number {
    if (this.shutdownDepth > 0) throw new Error(LOCAL_GAME_SHUTDOWN_IN_PROGRESS)
    return this.generation
  }

  beginShutdown(invalidateOpening = true): () => void {
    if (invalidateOpening) this.generation += 1
    this.shutdownDepth += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.shutdownDepth = Math.max(0, this.shutdownDepth - 1)
    }
  }

  assertOpeningCurrent(expectedGeneration: number): void {
    if (this.generation !== expectedGeneration || this.shutdownDepth > 0) {
      throw new Error(LOCAL_GAME_OPEN_CANCELLED)
    }
  }

  get shutdownInProgress(): boolean {
    return this.shutdownDepth > 0
  }
}
