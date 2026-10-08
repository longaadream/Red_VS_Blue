import { describe, expect, it } from 'vitest'

import {
  SOCIAL_COOLDOWN_MS,
  SOCIAL_MAX_TEXT_GRAPHEMES,
  SOCIAL_MAX_TEXT_LINES,
  SOCIAL_MAX_TEXT_UTF8_BYTES,
  SOCIAL_PRESET_ALLOWLIST,
  SOCIAL_PROTOCOL_VERSION,
  SOCIAL_STAMP_ALLOWLIST,
  BoundedSocialRequestCache,
  admitSocialMessage,
  createSocialMessageId,
  normalizeSocialRequest,
  type SocialEvent,
} from '@/lib/server/colyseus/battle-social'
import {
  SOCIAL_READY_MESSAGE,
  createSocialReadyMessage,
} from '@/lib/server/colyseus/battle-room-protocol'

const player = { playerId: 'player-red', displayName: '红方' }

function request(requestId: string, kind: 'text' | 'preset' | 'stamp' = 'text', payload = '你好') {
  return normalizeSocialRequest({ requestId, kind, payload })
}

describe('RED-241 room social admission', () => {
  it('accepts t0, rejects t2999, and accepts t3000 without changing the cooldown on rejection', () => {
    const first = request('one')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const atZero = admitSocialMessage({ ...player, request: first.request }, 0)
    expect(atZero).toMatchObject({
      ok: true,
      event: { messageId: createSocialMessageId(player.playerId, first.request.requestId), sentAt: 0 },
      nextLastSuccessfulAt: 0,
    })
    if (!atZero.ok) return

    const beforeCooldown = admitSocialMessage({ ...player, request: first.request }, SOCIAL_COOLDOWN_MS - 1, atZero.nextLastSuccessfulAt)
    expect(beforeCooldown).toMatchObject({ ok: false, code: 'SOCIAL_COOLDOWN', retryAfterMs: 1 })

    const atBoundary = admitSocialMessage({ ...player, request: first.request }, SOCIAL_COOLDOWN_MS, atZero.nextLastSuccessfulAt)
    expect(atBoundary).toMatchObject({ ok: true, event: { sentAt: SOCIAL_COOLDOWN_MS } })
  })

  it('keeps cooldowns independent by stable player ID and shares them across kinds', () => {
    const text = request('text', 'text', 'hello')
    const preset = request('preset', 'preset', SOCIAL_PRESET_ALLOWLIST[0])
    const stamp = request('stamp', 'stamp', SOCIAL_STAMP_ALLOWLIST[0])
    expect(text.ok && preset.ok && stamp.ok).toBe(true)
    if (!text.ok || !preset.ok || !stamp.ok) return

    const first = admitSocialMessage({ ...player, request: text.request }, 10)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(admitSocialMessage({ ...player, request: preset.request }, 11, first.nextLastSuccessfulAt)).toMatchObject({
      ok: false,
      code: 'SOCIAL_COOLDOWN',
    })
    expect(admitSocialMessage({ playerId: 'player-blue', displayName: '蓝方', request: stamp.request }, 11)).toMatchObject({
      ok: true,
    })
  })

  it('keeps the event ID stable for an idempotent reconnect retry', () => {
    const firstRequest = request('reconnect-1', 'text', 'hello')
    expect(firstRequest.ok).toBe(true)
    if (!firstRequest.ok) return

    const first = admitSocialMessage({ ...player, request: firstRequest.request }, 4_000)
    const retry = admitSocialMessage({ ...player, displayName: '重连后的名字', request: firstRequest.request }, 4_000)
    expect(first).toMatchObject({ ok: true, event: { messageId: createSocialMessageId('player-red', 'reconnect-1') } })
    expect(retry).toMatchObject({ ok: true, event: { messageId: createSocialMessageId('player-red', 'reconnect-1') } })
    if (!first.ok || !retry.ok) return
    expect(retry.event.messageId).toBe(first.event.messageId)
    expect(retry.event).toMatchObject({ playerId: first.event.playerId, kind: first.event.kind, payload: first.event.payload })
  })

  it('replays a cached event without a second broadcast for the same stable request key', () => {
    const cache = new BoundedSocialRequestCache<SocialEvent>()
    const key = 'player-red\u0000duplicate-1'
    const fingerprint = '["text","hello"]'
    const admitted = request('duplicate-1', 'text', 'hello')
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const result = admitSocialMessage({ ...player, request: admitted.request }, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const event = result.event
    const broadcasts: SocialEvent[] = []

    const send = () => {
      const cached = cache.get(key)
      if (cached?.response) return cached.response
      expect(cache.reserve(key, fingerprint)).toBe(true)
      cache.setResponse(key, event)
      broadcasts.push(event)
      return event
    }
    const first = send()
    const second = send()

    const cached = cache.get(key)
    expect(cached?.fingerprint).toBe(fingerprint)
    expect(cached?.response?.messageId).toBe(event.messageId)
    expect(second).toBe(first)
    expect(broadcasts).toHaveLength(1)
  })

  it('bounds plain text by grapheme count, lines, valid Unicode, and UTF-8 bytes', () => {
    const withinGraphemes = normalizeSocialRequest({
      requestId: 'graphemes-ok',
      kind: 'text',
      payload: 'a'.repeat(SOCIAL_MAX_TEXT_GRAPHEMES),
    })
    expect(withinGraphemes).toMatchObject({ ok: true })
    expect(normalizeSocialRequest({
      requestId: 'graphemes-too-long',
      kind: 'text',
      payload: 'a'.repeat(SOCIAL_MAX_TEXT_GRAPHEMES + 1),
    })).toMatchObject({ ok: false, code: 'SOCIAL_TEXT_TOO_LONG' })
    expect(normalizeSocialRequest({ requestId: 'lines-ok', kind: 'text', payload: '上行\n下行' })).toMatchObject({ ok: true })
    expect(normalizeSocialRequest({ requestId: 'lines-too-many', kind: 'text', payload: '一\n二\n三' })).toMatchObject({
      ok: false,
      code: 'SOCIAL_TEXT_TOO_MANY_LINES',
    })
    expect(normalizeSocialRequest({ requestId: 'unicode-invalid', kind: 'text', payload: String.fromCharCode(0xd800) })).toMatchObject({
      ok: false,
      code: 'SOCIAL_TEXT_INVALID',
    })

    const largeUtf8 = '🇨🇳'.repeat(SOCIAL_MAX_TEXT_GRAPHEMES)
    expect(new TextEncoder().encode(largeUtf8).byteLength).toBeGreaterThan(SOCIAL_MAX_TEXT_UTF8_BYTES)
    expect(normalizeSocialRequest({ requestId: 'utf8-too-large', kind: 'text', payload: largeUtf8 })).toMatchObject({
      ok: false,
      code: 'SOCIAL_TEXT_TOO_LARGE',
    })
  })

  it('only accepts allowlisted preset and stamp IDs', () => {
    expect(normalizeSocialRequest({ requestId: 'preset-ok', kind: 'preset', payload: SOCIAL_PRESET_ALLOWLIST[0] })).toMatchObject({
      ok: true,
      request: { kind: 'preset', payload: SOCIAL_PRESET_ALLOWLIST[0] },
    })
    expect(normalizeSocialRequest({ requestId: 'stamp-ok', kind: 'stamp', payload: SOCIAL_STAMP_ALLOWLIST[0] })).toMatchObject({
      ok: true,
      request: { kind: 'stamp', payload: SOCIAL_STAMP_ALLOWLIST[0] },
    })
    expect(normalizeSocialRequest({ requestId: 'preset-bad', kind: 'preset', payload: 'arbitrary text' })).toMatchObject({
      ok: false,
      code: 'SOCIAL_PRESET_NOT_ALLOWED',
    })
    expect(normalizeSocialRequest({ requestId: 'stamp-bad', kind: 'stamp', payload: 'arbitrary-stamp' })).toMatchObject({
      ok: false,
      code: 'SOCIAL_STAMP_NOT_ALLOWED',
    })
  })

  it('advertises the ready handshake and limits clients can use before sending', () => {
    expect(createSocialReadyMessage('hello-1')).toMatchObject({
      type: SOCIAL_READY_MESSAGE,
      supported: true,
      protocolVersion: SOCIAL_PROTOCOL_VERSION,
      cooldownMs: SOCIAL_COOLDOWN_MS,
      requestId: 'hello-1',
      limits: {
        text: {
          maxGraphemes: SOCIAL_MAX_TEXT_GRAPHEMES,
          maxLines: SOCIAL_MAX_TEXT_LINES,
          maxUtf8Bytes: SOCIAL_MAX_TEXT_UTF8_BYTES,
        },
      },
      presetIds: [...SOCIAL_PRESET_ALLOWLIST],
      stampIds: [...SOCIAL_STAMP_ALLOWLIST],
    })
  })
})
