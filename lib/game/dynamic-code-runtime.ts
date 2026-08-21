/**
 * Shared compiler for trusted, data-defined game code.
 *
 * This is deliberately not a sandbox: content is project-trusted.  It owns the
 * only eval boundary so Node and the browser bundle share cache, invalidation,
 * diagnostics, and compilation accounting.
 */
export type DynamicCodeSurface =
  | 'skillCode'
  | 'cardCode'
  | 'ruleSkillCode'
  | 'ruleTriggerSkill'
  | 'previewCode'
  | 'pendingEffectCode'

export class DynamicCodeRuntimeError extends Error {
  constructor(
    public readonly stage: 'compile' | 'entry' | 'execute',
    public readonly surface: DynamicCodeSurface,
    public readonly contentId: string,
    public readonly contentVersion: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[dynamic-code:${stage}] ${surface}:${contentId}@${contentVersion}: ${message}`)
    this.name = 'DynamicCodeRuntimeError'
  }
}

export type DynamicCodeRequest = {
  surface: DynamicCodeSurface
  contentId: string
  /** Caller-owned content revision.  Code changes also form part of the key. */
  contentVersion?: string
  code: string
  entry: string
}

type CachedCode = { code: string; value: unknown }

const ENGINE_RUNTIME_VERSION = 'red-82-v1'

/** Deterministic non-security hash. Exact source is retained to guard collisions. */
function hashCode(code: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class DynamicCodeRuntime {
  private readonly cache = new Map<string, CachedCode>()
  private readonly revisions = new Map<string, number>()
  private compiled = 0

  private revisionKey(surface: DynamicCodeSurface, contentId: string) {
    return `${surface}\u0000${contentId}`
  }

  private key(request: DynamicCodeRequest) {
    const revision = request.contentVersion ?? String(this.revisions.get(this.revisionKey(request.surface, request.contentId)) ?? 0)
    return `${ENGINE_RUNTIME_VERSION}\u0000${request.surface}\u0000${request.contentId}\u0000${revision}\u0000${hashCode(request.code)}`
  }

  compileExpression<T>(request: DynamicCodeRequest): T {
    const key = this.key(request)
    const cached = this.cache.get(key)
    if (cached?.code === request.code) return cached.value as T

    let value: unknown
    try {
      // Keep eval local to this runtime. The caller supplies a parenthesized expression.
      value = (0, eval)(request.code)
    } catch (cause) {
      throw new DynamicCodeRuntimeError('compile', request.surface, request.contentId, request.contentVersion ?? '0', `unable to compile ${request.entry}`, cause)
    }
    if (typeof value !== 'function') {
      throw new DynamicCodeRuntimeError('entry', request.surface, request.contentId, request.contentVersion ?? '0', `${request.entry} must compile to a function (received ${typeof value})`)
    }
    this.cache.set(key, { code: request.code, value })
    this.compiled += 1
    return value as T
  }

  forceReload(surface: DynamicCodeSurface, contentId: string) {
    const revisionKey = this.revisionKey(surface, contentId)
    this.revisions.set(revisionKey, (this.revisions.get(revisionKey) ?? 0) + 1)
    for (const key of this.cache.keys()) {
      if (key.includes(`\u0000${surface}\u0000${contentId}\u0000`)) this.cache.delete(key)
    }
  }

  clear() {
    this.cache.clear()
    this.revisions.clear()
    this.compiled = 0
  }

  stats() {
    return { compiled: this.compiled, cached: this.cache.size, engineVersion: ENGINE_RUNTIME_VERSION }
  }
}

export const dynamicCodeRuntime = new DynamicCodeRuntime()
