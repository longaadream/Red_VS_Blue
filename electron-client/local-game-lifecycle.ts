export const LOCAL_GAME_OPEN_CANCELLED = 'LOCAL_GAME_OPEN_CANCELLED'
export const LOCAL_GAME_SHUTDOWN_IN_PROGRESS = 'LOCAL_GAME_SHUTDOWN_IN_PROGRESS'

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
