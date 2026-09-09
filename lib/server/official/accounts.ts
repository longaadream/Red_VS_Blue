import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export class OfficialError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
export type Account = { id: string; email: string; name: string; banned: boolean }
export type MailSender = (to: string, purpose: 'verify' | 'reset', code: string) => Promise<void>
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const secret = () => randomBytes(32).toString('base64url')
export function emailAddress(value: unknown) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new OfficialError('请输入有效邮箱地址')
  return email
}
function passwordText(value: unknown) {
  if (typeof value !== 'string' || value.length < 10 || Buffer.byteLength(value) > 256) throw new OfficialError('密码至少10个字符，最多256字节')
  return value
}
let passwordJobs = 0
async function derive(password: string, salt: string): Promise<Buffer> {
  if (passwordJobs >= 4) throw new OfficialError('登录服务繁忙，请稍后重试', 429)
  passwordJobs++
  try {
    return await new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
  } finally { passwordJobs-- }
}
export async function hashPassword(value: unknown) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await derive(passwordText(value), salt)).toString('hex')}`
}
async function matchesPassword(password: unknown, encoded?: string) {
  const [salt, hash] = (encoded ?? `${'0'.repeat(32)}:${'0'.repeat(64)}`).split(':')
  const candidate = await derive(passwordText(password), salt)
  return !!encoded && hash.length === 64 && timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS official_accounts (
 id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
 banned BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS official_sessions (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES official_accounts(id),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS official_sessions_account ON official_sessions(account_id);
CREATE TABLE IF NOT EXISTS official_email_codes (
 email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, payload JSONB NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
 PRIMARY KEY(email,purpose)
);
CREATE TABLE IF NOT EXISTS official_rate_limits (
 key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);`

export class Accounts {
  constructor(readonly pool: Pool, private readonly sendMail: MailSender) {}
  async limit(key: string, maximum: number, seconds: number) {
    const result = await this.pool.query(`INSERT INTO official_rate_limits VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN official_rate_limits.expires_at <= now() THEN 1 ELSE official_rate_limits.count+1 END,
      expires_at=CASE WHEN official_rate_limits.expires_at <= now() THEN excluded.expires_at ELSE official_rate_limits.expires_at END
      RETURNING count`, [digest(key), seconds])
    if (result.rows[0].count > maximum) throw new OfficialError('操作过于频繁，请稍后重试', 429)
  }
  async requestCode(purpose: 'verify' | 'reset', input: Record<string, unknown>) {
    const email = emailAddress(input.email)
    await this.limit(`mail-minute:${email}`, 1, 60)
    await this.limit(`mail-day:${email}`, 12, 86400)
    const name = String(input.name ?? '').trim()
    if (purpose === 'verify' && (!name || name.length > 24 || /[\x00-\x1f<>]/.test(name))) throw new OfficialError('昵称需要1–24个字符，不能包含控制字符或尖括号')
    // Account creation happens only after verification. A squatter cannot choose
    // the password later installed by somebody else's verification attempt.
    const payload = purpose === 'verify' ? { name, passwordHash: await hashPassword(input.password) } : {}
    const exists = (await this.pool.query('SELECT id FROM official_accounts WHERE email=$1', [email])).rowCount
    if ((purpose === 'verify' && exists) || (purpose === 'reset' && !exists)) return
    const code = randomBytes(18).toString('base64url')
    await this.pool.query(`INSERT INTO official_email_codes(email,purpose,code_hash,payload) VALUES($1,$2,$3,$4)
      ON CONFLICT(email,purpose) DO UPDATE SET code_hash=excluded.code_hash,payload=excluded.payload,attempts=0,expires_at=excluded.expires_at`, [email, purpose, digest(code), payload])
    try { await this.sendMail(email, purpose, code) }
    catch {
      await this.pool.query('DELETE FROM official_email_codes WHERE email=$1 AND purpose=$2 AND code_hash=$3', [email, purpose, digest(code)])
      throw new OfficialError('邮件暂时无法发送，请联系服务器管理员检查发信配置后重试', 503)
    }
  }
  async redeem(purpose: 'verify' | 'reset', input: Record<string, unknown>) {
    const email = emailAddress(input.email), code = String(input.code ?? '').trim()
    const newHash = purpose === 'reset' ? await hashPassword(input.password) : undefined
    // Increment attempts outside the redeem transaction so failed attempts commit.
    const found = await this.pool.query(`UPDATE official_email_codes SET attempts=attempts+1
      WHERE email=$1 AND purpose=$2 AND expires_at>now() AND attempts<5 RETURNING code_hash`, [email, purpose])
    if (!found.rowCount || !timingSafeEqual(Buffer.from(found.rows[0].code_hash), Buffer.from(digest(code)))) throw new OfficialError('验证代码无效、已使用或已过期')
    await transaction(this.pool, async client => {
      const result = await client.query(`DELETE FROM official_email_codes WHERE email=$1 AND purpose=$2 AND code_hash=$3 AND expires_at>now() RETURNING payload`, [email, purpose, digest(code)])
      if (!result.rowCount) throw new OfficialError('验证代码已使用，请重新申请')
      if (purpose === 'verify') {
        const payload = result.rows[0].payload as { name: string; passwordHash: string }
        await client.query('INSERT INTO official_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING', [randomUUID(), email, payload.name, payload.passwordHash])
      } else {
        const updated = await client.query('UPDATE official_accounts SET password_hash=$2 WHERE email=$1 RETURNING id', [email, newHash])
        if (updated.rowCount) await client.query('DELETE FROM official_sessions WHERE account_id=$1', [updated.rows[0].id])
      }
    })
  }
  async login(input: Record<string, unknown>) {
    const email = emailAddress(input.email)
    await this.limit(`login:${email}`, 15, 900)
    const row = (await this.pool.query('SELECT * FROM official_accounts WHERE email=$1', [email])).rows[0]
    if (!await matchesPassword(input.password, row?.password_hash) || row?.banned) throw new OfficialError('邮箱、密码不正确，账号未验证或暂不可用', 401)
    const token = secret()
    // Serialize with password reset so a login cannot issue a stale session after reset.
    await transaction(this.pool, async client => {
      const current = (await client.query('SELECT password_hash,banned FROM official_accounts WHERE id=$1 FOR UPDATE', [row.id])).rows[0]
      if (current.password_hash !== row.password_hash || current.banned) throw new OfficialError('账号状态已变化，请重新登录', 401)
      await client.query('DELETE FROM official_sessions WHERE account_id=$1', [row.id])
      await client.query('INSERT INTO official_sessions(token_hash,account_id) VALUES($1,$2)', [digest(token), row.id])
    })
    return { token, account: { id: row.id, name: row.name, email: row.email } }
  }
  async authenticate(token: unknown): Promise<Account> {
    if (typeof token !== 'string' || token.length > 100 || token.length < 20) throw new OfficialError('请登录服务器账号', 401)
    const result = await this.pool.query(`SELECT a.id,a.email,a.name,a.banned FROM official_sessions s
      JOIN official_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT a.banned`, [digest(token)])
    if (!result.rowCount) throw new OfficialError('登录已过期，请重新登录', 401)
    return result.rows[0] as Account
  }
  async logout(token: string) { await this.pool.query('DELETE FROM official_sessions WHERE token_hash=$1', [digest(token)]) }
}
