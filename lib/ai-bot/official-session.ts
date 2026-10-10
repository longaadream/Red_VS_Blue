import { URL } from 'node:url'

export interface OfficialSession {
  token: string
  accountId?: string
  accountName?: string
  accountEmail?: string
}

export interface OfficialSessionOptions {
  serverUrl: string
  token?: string
  email?: string
  password?: string
  env?: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * Resolve an existing official session without ever printing or persisting its
 * bearer token.  The token path is useful for a pre-created bot session; the
 * email/password path only calls the existing login endpoint and is intended
 * for short-lived local/cloud process startup.
 */
export async function resolveOfficialSession(options: OfficialSessionOptions): Promise<OfficialSession> {
  const environment = options.env ?? process.env
  const token = options.token?.trim() || environment.RVB_BOT_OFFICIAL_TOKEN?.trim()
  if (token) return { token }

  const email = options.email?.trim() || environment.RVB_BOT_ACCOUNT_EMAIL?.trim()
  const password = options.password ?? environment.RVB_BOT_PASSWORD
  if (!email || !password) {
    throw officialSessionError('OFFICIAL_CREDENTIALS_REQUIRED', 'An official token or bot login credentials are required')
  }
  return loginOfficialSession({
    serverUrl: options.serverUrl,
    email: options.email?.trim() || email,
    password: options.password ?? password,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  })
}

/**
 * Read the account attached to an already-issued official bearer token.  The
 * token is sent only as an Authorization header and is never included in an
 * exception message or returned diagnostic.
 */
export async function readOfficialSession(options: Required<Pick<OfficialSessionOptions, 'serverUrl' | 'token'>> & Pick<OfficialSessionOptions, 'fetchFn' | 'timeoutMs'>): Promise<OfficialSession> {
  const endpoint = httpEndpoint(options.serverUrl, '/official/me')
  const fetchImpl = options.fetchFn ?? fetch
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 10_000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json', authorization: `Bearer ${options.token}` },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw officialSessionError('OFFICIAL_SESSION_FAILED', `Official session lookup failed with HTTP ${response.status}`)
    let payload: unknown
    try { payload = await response.json() } catch {
      throw officialSessionError('OFFICIAL_SESSION_INVALID_RESPONSE', 'Official session lookup returned invalid JSON')
    }
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const account = body.account && typeof body.account === 'object' ? body.account as Record<string, unknown> : {}
    const accountId = typeof account.id === 'string' && account.id.trim() ? account.id.trim().toLowerCase() : ''
    const accountName = typeof account.name === 'string' && account.name.trim() ? account.name.trim() : ''
    if (!accountId || !accountName) {
      throw officialSessionError('OFFICIAL_SESSION_INVALID_RESPONSE', 'Official session lookup did not return an account identity')
    }
    return {
      token: options.token,
      accountId,
      accountName,
      ...(typeof account.email === 'string' && account.email.trim() ? { accountEmail: account.email.trim().toLowerCase() } : {}),
    }
  } catch (error) {
    if (isAbortError(error)) throw officialSessionError('OFFICIAL_SESSION_TIMEOUT', `Official session lookup timed out after ${timeoutMs}ms`)
    if (isOfficialSessionError(error)) throw error
    throw officialSessionError('OFFICIAL_SESSION_FAILED', 'Official session lookup request failed')
  } finally {
    clearTimeout(timeout)
  }
}

export async function loginOfficialSession(options: Required<Pick<OfficialSessionOptions, 'serverUrl' | 'email' | 'password'>> & Pick<OfficialSessionOptions, 'fetchFn' | 'timeoutMs'>): Promise<OfficialSession> {
  const endpoint = httpEndpoint(options.serverUrl, '/official/auth/login')
  const fetchImpl = options.fetchFn ?? fetch
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 10_000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email: options.email, password: options.password }),
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw officialSessionError('OFFICIAL_LOGIN_FAILED', `Official login failed with HTTP ${response.status}`)
    }
    let payload: unknown
    try { payload = await response.json() } catch {
      throw officialSessionError('OFFICIAL_LOGIN_INVALID_RESPONSE', 'Official login returned invalid JSON')
    }
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const resolvedToken = typeof body.token === 'string' ? body.token.trim() : ''
    if (!resolvedToken) throw officialSessionError('OFFICIAL_LOGIN_INVALID_RESPONSE', 'Official login did not return a session token')
    const account = body.account && typeof body.account === 'object' ? body.account as Record<string, unknown> : {}
    return {
      token: resolvedToken,
      ...(typeof account.id === 'string' && account.id.trim() ? { accountId: account.id.trim().toLowerCase() } : {}),
      ...(typeof account.name === 'string' && account.name.trim() ? { accountName: account.name.trim() } : {}),
      ...(typeof account.email === 'string' && account.email.trim() ? { accountEmail: account.email.trim().toLowerCase() } : {}),
    }
  } catch (error) {
    if (isAbortError(error)) throw officialSessionError('OFFICIAL_LOGIN_TIMEOUT', `Official login timed out after ${timeoutMs}ms`)
    if (isOfficialSessionError(error)) throw error
    throw officialSessionError('OFFICIAL_LOGIN_FAILED', 'Official login request failed')
  } finally {
    clearTimeout(timeout)
  }
}

export function httpEndpoint(serverUrl: string, path: string): string {
  const url = new URL(serverUrl)
  const sourceProtocol = url.protocol
  if (sourceProtocol === 'ws:') url.protocol = 'http:'
  else if (sourceProtocol === 'wss:') url.protocol = 'https:'
  if (sourceProtocol !== 'ws:' && sourceProtocol !== 'wss:' && sourceProtocol !== 'http:' && sourceProtocol !== 'https:') {
    throw officialSessionError('SERVER_URL_INVALID', 'serverUrl must use http(s) or ws(s)')
  }
  if ((sourceProtocol === 'http:' || sourceProtocol === 'ws:') && !isLoopback(url.hostname)) {
    throw officialSessionError('SERVER_URL_INSECURE', 'Public cloud bot connections must use HTTPS or WSS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw officialSessionError('SERVER_URL_CREDENTIALS_FORBIDDEN', 'serverUrl cannot contain credentials, query parameters, or a fragment')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  url.pathname = `${basePath}${suffix}` || '/'
  return url.toString()
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1'
}

export class OfficialSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OfficialSessionError'
  }
}

function officialSessionError(code: string, message: string): OfficialSessionError {
  return new OfficialSessionError(code, message)
}

function isOfficialSessionError(error: unknown): error is OfficialSessionError {
  return error instanceof OfficialSessionError
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 120_000) : 10_000
}
