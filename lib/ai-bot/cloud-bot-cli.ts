import { readFileSync } from 'node:fs'

import {
  CloudBotTransport,
  CloudBotTransportError,
  normalizeCloudBotPieces,
  type CloudBotClientLike,
  type CloudBotConfig,
  type CloudBotDecide,
  type CloudBotRunResult,
} from './transport'
import { prepareOfficialMatch } from './official-lobby'
import { resolveOfficialSession, httpEndpoint } from './official-session'
import type { GoalPolicyOptions, ShadowGoal } from './goal-policy'

const SENSITIVE_CONFIG_KEYS = new Set([
  'token', 'officialToken', 'password', 'email', 'authorization', 'secret', 'credentials',
])

export interface CloudBotExecutionOptions {
  decide: CloudBotDecide
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
  client?: CloudBotClientLike
  trustedProfileIdentity?: CloudBotTransportOptionsProfile
}

export type CloudBotTransportOptionsProfile = import('@/lib/content-pipeline/runtime/profile-game-identity').GameProfileIdentityV1

export interface CloudBotValidationResult {
  config: CloudBotConfig
}

/** Convert the user-facing goal JSON into the narrow policy options contract. */
export function createCloudBotGoalOptions(goal: Record<string, unknown> | undefined, budgetMs: number): GoalPolicyOptions {
  const kind = goal?.kind
  const templateId = typeof goal?.templateId === 'string'
    ? goal.templateId
    : typeof goal?.summonTemplateId === 'string' ? goal.summonTemplateId : undefined
  const targetId = typeof goal?.targetInstanceId === 'string'
    ? goal.targetInstanceId
    : typeof goal?.targetId === 'string' ? goal.targetId : undefined
  const normalizedGoal: ShadowGoal | undefined = kind === 'summon' && templateId
    ? { kind: 'summon', templateId }
    : kind === 'eliminate' && targetId
      ? { kind: 'eliminate', targetId }
      : undefined
  const configuredTime = typeof goal?.maxTimeMs === 'number' && Number.isSafeInteger(goal.maxTimeMs) && goal.maxTimeMs > 0
    ? goal.maxTimeMs
    : budgetMs
  // Leave room in the transport deadline for the policy's projection and
  // fallback packaging after the bounded search returns.
  const searchBudgetMs = Math.max(1, Math.floor(budgetMs * 0.7))
  const options: GoalPolicyOptions = {
    ...(normalizedGoal ? { goal: normalizedGoal } : {}),
    maxTimeMs: Math.min(searchBudgetMs, configuredTime),
  }
  for (const key of ['maxNodes', 'maxDepth'] as const) {
    const value = goal?.[key]
    if (Number.isSafeInteger(value) && Number(value) > 0) options[key] = Number(value)
  }
  return options
}

export function parseCloudBotConfig(value: unknown): CloudBotConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configError('CONFIG_OBJECT_REQUIRED', 'Cloud bot config must be a JSON object')
  rejectSensitiveKeys(value)
  const source = value as Record<string, unknown>
  const serverUrl = requiredString(source.serverUrl, 'serverUrl')
  // This performs URL syntax, credential, and public-transport TLS checks
  // without making a request. --check-config therefore stays offline.
  httpEndpoint(serverUrl, '/catalog/identity')
  const roomId = optionalId(source.roomId)
  const create = parseCreate(source.create)
  const mode = source.mode === undefined ? 'direct' : source.mode
  if (mode !== 'direct' && mode !== 'official') throw configError('MODE_INVALID', 'mode must be direct or official')
  if (mode === 'direct' && (roomId ? 1 : 0) + (create ? 1 : 0) !== 1) throw configError('ROOM_SELECTION_REQUIRED', 'Provide exactly one of roomId or create')
  if (mode === 'official' && create) throw configError('OFFICIAL_CREATE_FORBIDDEN', 'Official rooms must come from server matchmaking')
  const alignment = source.alignment
  if (alignment !== 'light' && alignment !== 'dark') throw configError('ALIGNMENT_INVALID', 'alignment must be light or dark')
  const playerId = mode === 'official' && (source.playerId === undefined || source.playerId === '') ? '' : requiredId(source.playerId, 'playerId')
  const playerName = mode === 'official' && (source.playerName === undefined || source.playerName === '') ? '' : requiredText(source.playerName, 'playerName', 64)
  const accountId = optionalId(source.accountId)
  if (mode === 'official' && accountId && playerId && accountId !== playerId) throw configError('OFFICIAL_ID_CONFLICT', 'accountId and playerId must match in official mode')
  const pieces = normalizeCloudBotPieces(source.pieces)
  const result: CloudBotConfig = {
    serverUrl,
    ...(roomId ? { roomId } : {}),
    ...(create ? { create } : {}),
    playerId,
    playerName,
    alignment,
    pieces,
    ...(accountId ? { accountId } : {}),
    mode,
    ...(source.goal === undefined ? {} : { goal: parseGoal(source.goal) }),
    ...(source.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: positive(source.maxRuntimeMs, 'maxRuntimeMs', 86_400_000) }),
    ...(source.maxActions === undefined ? {} : { maxActions: positive(source.maxActions, 'maxActions', 100_000) }),
    ...(source.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: positive(source.requestTimeoutMs, 'requestTimeoutMs', 120_000) }),
    ...(source.maxConsecutiveRejections === undefined ? {} : { maxConsecutiveRejections: positive(source.maxConsecutiveRejections, 'maxConsecutiveRejections', 20) }),
    ...(source.decisionBudgetMs === undefined ? {} : { decisionBudgetMs: positive(source.decisionBudgetMs, 'decisionBudgetMs', 120_000) }),
  }
  return result
}

export function readCloudBotConfig(path: string): CloudBotConfig {
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch {
    throw configError('CONFIG_READ_FAILED', `Unable to read config file ${path}`)
  }
  return parseCloudBotConfig(value)
}

export function validateCloudBotConfig(value: unknown): CloudBotValidationResult {
  return { config: parseCloudBotConfig(value) }
}

export async function executeCloudBot(
  configValue: CloudBotConfig | unknown,
  options: CloudBotExecutionOptions,
): Promise<CloudBotRunResult> {
  const config = isCloudBotConfig(configValue) ? parseCloudBotConfig(configValue) : parseCloudBotConfig(configValue)
  if (typeof options.decide !== 'function') throw configError('GOAL_POLICY_REQUIRED', 'A goal policy decision function is required')
  const environment = options.env ?? process.env
  let token: string | undefined
  let accountId = config.accountId
  let playerName = config.playerName
  let roomId = config.roomId
  let maxRuntimeMs = config.maxRuntimeMs ?? 15 * 60_000
  if (config.mode === 'official') {
    const session = await resolveOfficialSession({ serverUrl: config.serverUrl, env: environment, fetchFn: options.fetchFn })
    token = session.token
    const prepared = await prepareOfficialMatch({
      serverUrl: config.serverUrl,
      token,
      profileIdentity: options.trustedProfileIdentity,
      alignment: config.alignment,
      pieces: config.pieces,
      roomId,
      expectedPlayerId: config.playerId || accountId,
      expectedPlayerName: config.playerName || undefined,
      maxRuntimeMs,
      fetchFn: options.fetchFn,
      signal: options.signal,
    })
    if (accountId && accountId !== prepared.playerId) throw configError('OFFICIAL_ACCOUNT_MISMATCH', 'Configured accountId does not match the authenticated account')
    if (config.playerId && config.playerId !== prepared.playerId) throw configError('OFFICIAL_PLAYER_MISMATCH', 'Configured playerId does not match the authenticated account')
    if (config.playerName && config.playerName !== prepared.playerName) throw configError('OFFICIAL_PLAYER_NAME_MISMATCH', 'Configured playerName does not match the authenticated account')
    accountId = prepared.playerId
    config.playerId = prepared.playerId
    playerName = prepared.playerName
    roomId = prepared.roomId
    maxRuntimeMs -= prepared.elapsedMs
    if (maxRuntimeMs <= 0) throw configError('OFFICIAL_RUNTIME_LIMIT', 'Official matchmaking used the configured runtime budget')
  }
  const runtimeConfig = { ...config, ...(roomId ? { roomId } : {}), accountId, playerName, maxRuntimeMs }
  const transport = new CloudBotTransport({
    config: runtimeConfig,
    officialToken: token,
    client: options.client,
    fetchFn: options.fetchFn,
    trustedProfileIdentity: options.trustedProfileIdentity,
  })
  try {
    return await transport.run({
      decide: options.decide,
      signal: options.signal,
      maxRuntimeMs: runtimeConfig.maxRuntimeMs,
      maxActions: runtimeConfig.maxActions,
    })
  } finally {
    await transport.leave()
  }
}

export function publicRunResult(result: CloudBotRunResult): Record<string, unknown> {
  return {
    status: result.status,
    actionCount: result.actionCount,
    roomId: result.roomId,
    authorityVersion: result.authorityVersion,
    ...(result.terminal ? { terminal: result.terminal } : {}),
  }
}

function parseCreate(value: unknown): CloudBotConfig['create'] | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configError('CREATE_INVALID', 'create must be an object')
  rejectSensitiveKeys(value)
  const source = value as Record<string, unknown>
  const name = requiredText(source.name, 'create.name', 80)
  const mapId = requiredId(source.mapId, 'create.mapId')
  const visibility = source.visibility === undefined ? 'public' : source.visibility
  if (visibility !== 'public' && visibility !== 'private') throw configError('VISIBILITY_INVALID', 'create.visibility must be public or private')
  return { name, mapId, visibility }
}

function parseGoal(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configError('GOAL_INVALID', 'goal must be an object')
  rejectSensitiveKeys(value)
  const source = value as Record<string, unknown>
  if (source.kind !== undefined && source.kind !== 'summon' && source.kind !== 'eliminate') throw configError('GOAL_KIND_INVALID', 'goal.kind must be summon or eliminate')
  return { ...source }
}

function rejectSensitiveKeys(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveKeys(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_CONFIG_KEYS.has(key) || /token|password|secret|authorization|credential/i.test(key)) {
      throw configError('CONFIG_SECRET_FORBIDDEN', `${path}.${key} must be supplied through the process environment`)
    }
    rejectSensitiveKeys(entry, `${path}.${key}`)
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw configError('CONFIG_FIELD_REQUIRED', `${name} is required`)
  return value.trim()
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  const text = requiredString(value, name)
  if (text.length > maxLength) throw configError('CONFIG_FIELD_INVALID', `${name} is too long`)
  return text
}

function requiredId(value: unknown, name: string): string {
  const text = requiredText(value, name, 128).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(text)) throw configError('CONFIG_ID_INVALID', `${name} contains unsupported characters`)
  return text
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined
}

function positive(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) throw configError('CONFIG_NUMBER_INVALID', `${name} must be a positive integer no greater than ${maximum}`)
  return Number(value)
}

function isCloudBotConfig(value: unknown): value is CloudBotConfig {
  return !!value && typeof value === 'object' && typeof (value as { serverUrl?: unknown }).serverUrl === 'string'
}

function configError(code: string, message: string): CloudBotTransportError {
  return new CloudBotTransportError(code, message)
}
