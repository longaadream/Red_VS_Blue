/**
 * The social channel deliberately lives beside BattleRoom rather than in the
 * battle reducer.  A social message is room-scoped presentation data: it is
 * authenticated by the room session, but it must never change BattleState or
 * consume an authority version.
 */

export const SOCIAL_PROTOCOL_VERSION = 1 as const
export const SOCIAL_COOLDOWN_MS = 3_000
export const SOCIAL_MAX_TEXT_GRAPHEMES = 60
export const SOCIAL_MAX_TEXT_LINES = 2
export const SOCIAL_MAX_TEXT_UTF8_BYTES = 256
export const SOCIAL_MAX_REQUEST_ID_LENGTH = 128
export const SOCIAL_MAX_REQUEST_CACHE = 512
export const SOCIAL_MAX_PLAYER_TRACKING = 64

export const SOCIAL_KINDS = ['text', 'preset', 'stamp'] as const
export type SocialKind = typeof SOCIAL_KINDS[number]

// These IDs are protocol data, rather than user supplied text.  Clients use
// the lists from socialReady so an older client can fail closed when a server
// does not advertise this channel.
export const SOCIAL_PRESET_ALLOWLIST = [
  'hello',
  'good-luck',
  'nice-move',
  'well-played',
  'thanks',
  'sorry',
  'gg',
] as const

export const SOCIAL_STAMP_ALLOWLIST = [
  'thumbs-up',
  'heart',
  'clap',
  'laugh',
  'warning',
  'skull',
  'star',
] as const

export interface NormalizedSocialRequest {
  requestId: string
  kind: SocialKind
  payload: string
}

export interface SocialValidationFailure {
  ok: false
  code: string
  message: string
}

export interface SocialValidationSuccess {
  ok: true
  request: NormalizedSocialRequest
}

export type SocialValidationResult = SocialValidationFailure | SocialValidationSuccess

export interface SocialEvent {
  messageId: string
  playerId: string
  displayName: string
  kind: SocialKind
  payload: string
  sentAt: number
}

export interface SocialRequestCacheRecord<T> {
  fingerprint: string
  response?: T
  pending?: Promise<T>
}

/**
 * Bounded replay cache shared by the room handler and its focused tests.  A
 * pending entry is never evicted, which keeps concurrent retries attached to
 * the one admission/broadcast promise; completed entries are the only ones
 * eligible for oldest-first eviction.
 */
export class BoundedSocialRequestCache<T> {
  private readonly records = new Map<string, SocialRequestCacheRecord<T>>()

  constructor(private readonly maxSize = SOCIAL_MAX_REQUEST_CACHE) {}

  get(key: string): SocialRequestCacheRecord<T> | undefined {
    return this.records.get(key)
  }

  reserve(key: string, fingerprint: string): boolean {
    if (this.records.has(key)) return false
    if (this.records.size >= this.maxSize) {
      const evictable = [...this.records.entries()].find(([, record]) => !record.pending)
      if (!evictable) return false
      this.records.delete(evictable[0])
    }
    this.records.set(key, { fingerprint })
    return true
  }

  setPending(key: string, pending: Promise<T>): void {
    const record = this.records.get(key)
    if (record) record.pending = pending
  }

  setResponse(key: string, response: T): void {
    const record = this.records.get(key)
    if (record) {
      record.response = response
      record.pending = undefined
    }
  }

  clear(): void {
    this.records.clear()
  }
}

export interface SocialAdmissionInput {
  playerId: string
  displayName: string
  request: NormalizedSocialRequest
}

export interface SocialAdmissionSuccess {
  ok: true
  event: SocialEvent
  nextLastSuccessfulAt: number
  cooldownUntil: number
}

export interface SocialAdmissionFailure {
  ok: false
  code: string
  message: string
  retryAfterMs?: number
  retryAt?: number
}

export type SocialAdmissionResult = SocialAdmissionSuccess | SocialAdmissionFailure

/**
 * Parse and validate a wire request without consulting room state.  The
 * payload is intentionally reduced to a string ID for preset/stamp messages;
 * arbitrary objects never cross the room boundary.
 */
export function normalizeSocialRequest(message: unknown): SocialValidationResult {
  if (!isPlainObject(message)) return failure('SOCIAL_REQUEST_INVALID', 'Social request must be an object')

  const requestId = normalizeRequestId(message.requestId)
  if (!requestId) return failure('SOCIAL_REQUEST_ID_REQUIRED', 'requestId is required')
  if (requestId.length > SOCIAL_MAX_REQUEST_ID_LENGTH) {
    return failure('SOCIAL_REQUEST_ID_TOO_LONG', `requestId must be at most ${SOCIAL_MAX_REQUEST_ID_LENGTH} characters`)
  }

  const kind = typeof message.kind === 'string' ? message.kind.trim().toLowerCase() : ''
  if (!isSocialKind(kind)) return failure('SOCIAL_KIND_UNSUPPORTED', 'Social kind is unsupported')

  const rawPayload = message.payload ?? payloadAlias(message, kind)
  if (kind === 'text') {
    const textPayload = typeof rawPayload === 'string'
      ? rawPayload
      : isPlainObject(rawPayload) && typeof rawPayload.text === 'string'
        ? rawPayload.text
        : undefined
    if (textPayload === undefined) return failure('SOCIAL_TEXT_REQUIRED', 'Text social payload must be a string')
    const text = normalizeSocialText(textPayload)
    if (!text.ok) return text
    return { ok: true, request: { requestId, kind, payload: text.value } }
  }

  const id = normalizeSocialId(rawPayload)
  if (!id) return failure(
    kind === 'preset' ? 'SOCIAL_PRESET_REQUIRED' : 'SOCIAL_STAMP_REQUIRED',
    `${kind} social payload must be an ID`,
  )
  const allowlist = kind === 'preset' ? SOCIAL_PRESET_ALLOWLIST : SOCIAL_STAMP_ALLOWLIST
  if (!allowlist.includes(id as never)) {
    return failure(
      kind === 'preset' ? 'SOCIAL_PRESET_NOT_ALLOWED' : 'SOCIAL_STAMP_NOT_ALLOWED',
      `${kind} social payload is not allowed`,
    )
  }
  return { ok: true, request: { requestId, kind, payload: id } }
}

/**
 * Pure admission helper.  It returns the next timestamp rather than mutating
 * a room map, so tests can cover the exact t0/2999/3000 boundary and callers
 * can commit the timestamp only after validation succeeds.
 */
export function admitSocialMessage(
  input: SocialAdmissionInput,
  now: number,
  lastSuccessfulAt?: number,
): SocialAdmissionResult {
  if (!Number.isFinite(now)) {
    return { ok: false, code: 'SOCIAL_CLOCK_INVALID', message: 'Social clock is unavailable' }
  }
  if (lastSuccessfulAt !== undefined && now - lastSuccessfulAt < SOCIAL_COOLDOWN_MS) {
    const cooldownUntil = lastSuccessfulAt + SOCIAL_COOLDOWN_MS
    const retryAfterMs = Math.max(0, cooldownUntil - now)
    return {
      ok: false,
      code: 'SOCIAL_COOLDOWN',
      message: 'Social messages are rate limited',
      retryAfterMs,
      retryAt: cooldownUntil,
    }
  }
  const event: SocialEvent = {
    messageId: createSocialMessageId(input.playerId, input.request.requestId),
    playerId: input.playerId,
    displayName: input.displayName,
    kind: input.request.kind,
    payload: input.request.payload,
    sentAt: now,
  }
  return {
    ok: true,
    event,
    nextLastSuccessfulAt: now,
    cooldownUntil: now + SOCIAL_COOLDOWN_MS,
  }
}

/**
 * A room-local, deterministic event ID.  Stable player identity plus the
 * client request ID makes reconnect retries idempotent without trusting a
 * client-supplied timestamp or accepting a second broadcast.
 */
export function createSocialMessageId(playerId: string, requestId: string): string {
  return `social:${JSON.stringify([playerId, requestId])}`
}

// A descriptive alias for callers that use the wire terminology.
export const admitSocialSend = admitSocialMessage

export function normalizeRequestId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return /[\u0000-\u001F\u007F]/u.test(normalized) ? '' : normalized
}

export function extractSocialRequestId(message: unknown): string {
  return isPlainObject(message) ? normalizeRequestId(message.requestId) : ''
}

function normalizeSocialText(value: string):
  | { ok: true; value: string }
  | SocialValidationFailure {
  // A valid UTF-8 string is at least one byte per UTF-16 code unit.  Rejecting
  // this cheap upper bound before grapheme segmentation keeps malformed or
  // oversized input from consuming unbounded CPU in Intl.Segmenter.
  if (value.length > SOCIAL_MAX_TEXT_UTF8_BYTES) {
    return failure('SOCIAL_TEXT_TOO_LARGE', `Text must be at most ${SOCIAL_MAX_TEXT_UTF8_BYTES} UTF-8 bytes`)
  }
  if (!isWellFormedUnicode(value)) return failure('SOCIAL_TEXT_INVALID', 'Text contains invalid Unicode')
  const normalized = value.replace(/\r\n?|\u2028|\u2029/g, '\n').trim()
  if (!normalized) return failure('SOCIAL_TEXT_EMPTY', 'Text social payload cannot be empty')
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    return failure('SOCIAL_TEXT_INVALID', 'Text contains unsupported control characters')
  }
  const lineCount = normalized.split('\n').length
  if (lineCount > SOCIAL_MAX_TEXT_LINES) {
    return failure('SOCIAL_TEXT_TOO_MANY_LINES', `Text must fit within ${SOCIAL_MAX_TEXT_LINES} lines`)
  }
  const graphemeCount = countGraphemes(normalized)
  if (graphemeCount > SOCIAL_MAX_TEXT_GRAPHEMES) {
    return failure('SOCIAL_TEXT_TOO_LONG', `Text must be at most ${SOCIAL_MAX_TEXT_GRAPHEMES} characters`)
  }
  const utf8Bytes = new TextEncoder().encode(normalized).byteLength
  if (utf8Bytes > SOCIAL_MAX_TEXT_UTF8_BYTES) {
    return failure('SOCIAL_TEXT_TOO_LARGE', `Text must be at most ${SOCIAL_MAX_TEXT_UTF8_BYTES} UTF-8 bytes`)
  }
  return { ok: true, value: normalized }
}

function payloadAlias(message: Record<string, unknown>, kind: string): unknown {
  if (kind === 'text') return message.text
  if (kind === 'preset') return message.presetId ?? message.id ?? message.value
  return message.stampId ?? message.id ?? message.value
}

function normalizeSocialId(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length <= SOCIAL_MAX_REQUEST_ID_LENGTH ? normalized.toLowerCase() : ''
  }
  if (isPlainObject(value)) {
    const id = value.id ?? value.value ?? value.presetId ?? value.stampId
    if (typeof id !== 'string') return ''
    const normalized = id.trim()
    return normalized.length <= SOCIAL_MAX_REQUEST_ID_LENGTH ? normalized.toLowerCase() : ''
  }
  return ''
}

function isSocialKind(value: string): value is SocialKind {
  return (SOCIAL_KINDS as readonly string[]).includes(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function failure(code: string, message: string): SocialValidationFailure {
  return { ok: false, code, message }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

function countGraphemes(value: string): number {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
    ) => { segment(input: string): Iterable<unknown> }
  }).Segmenter
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
  return Array.from(value).length
}
