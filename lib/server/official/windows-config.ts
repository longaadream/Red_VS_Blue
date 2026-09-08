import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { equalToken } from './token'
import fs from 'node:fs'
import path from 'node:path'
import type { SmtpSettings } from './mail'
import { createSmtpMailer } from './mail'

export function protectWindowsSecret(value: string): Buffer {
  return Buffer.from(dpapi(value, false), 'utf8')
}
export function unprotectWindowsSecret(value: Buffer): string { return dpapi(value.toString('utf8'), true) }
function dpapi(value: string, decrypt: boolean) {
  if (process.platform !== 'win32') throw new Error('Windows凭据保护只能在Windows使用')
  const setup = `[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $inputValue=[Console]::In.ReadToEnd(); `
  const command = setup + (decrypt
    ? `[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`
    : `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($inputValue),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (result.status !== 0 || !result.stdout) throw new Error('Windows凭据保护失败，请用原Windows用户运行')
  return result.stdout
}
export type OfficialConfig = { port: number; maxMatches: number; smtp: SmtpSettings }
export function loadConfig(file: string): OfficialConfig | undefined {
  if (!fs.existsSync(file)) return undefined
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { ...saved, smtp: { ...saved.smtp, password: unprotectWindowsSecret(Buffer.from(saved.smtp.password, 'utf8')) } }
}
export function saveConfig(file: string, config: OfficialConfig) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const value = { ...config, smtp: { ...config.smtp, password: protectWindowsSecret(config.smtp.password).toString('utf8') } }
  const temp = file + '.new'
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
}

export async function configureWindows(file: string, open: (url: string) => void): Promise<OfficialConfig> {
  const key = randomBytes(32).toString('hex')
  return new Promise((resolve, reject) => {
    let origin = '', saving = false
    const server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'")
      if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return }
      if (request.method === 'GET' && request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(SETUP_HTML); return }
      const token = String(request.headers['x-setup-token'] ?? '')
      if (request.method !== 'POST' || request.url !== '/save' || request.headers.origin !== origin || !equalToken(token, key) || saving) { response.writeHead(403).end(); return }
      saving = true
      try {
        let body = ''
        for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 8192) throw new Error('配置内容过长') }
        const value = JSON.parse(body) as OfficialConfig
        if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !Number.isInteger(value.maxMatches) || value.maxMatches < 1 || value.maxMatches > 50) throw new Error('游戏端口须为1024–65535，同时比赛上限须为1–50')
        const mail = createSmtpMailer(value.smtp)
        try { await mail.verify() } catch { throw new Error('SMTP连接或授权失败。请检查SMTP服务是否开启、邮箱地址和授权码是否正确，及网络是否可用。') } finally { mail.close() }
        saveConfig(file, value)
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, url: `http://127.0.0.1:${value.port}/official.html` }))
        server.close(); resolve(value)
      } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : '配置失败' })); saving = false }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      console.info(`[official] 邮件配置：${origin}/#${key}`)
      open(`${origin}/#${key}`)
    })
  })
}

const SETUP_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>官方服首次设置</title><style>body{font:16px/1.7 system-ui;background:#101827;color:#e2e8f0;max-width:620px;margin:40px auto;padding:20px}label{display:block;margin-top:14px}input,select,button{box-sizing:border-box;padding:10px;width:100%;font:inherit;border-radius:6px}button{margin-top:24px;background:#2563eb;color:white;border:0;cursor:pointer}p{color:#b7c8dd}#error{color:#fca5a5}small{color:#94a3b8}</style><h1>官方排位服务器设置</h1><p>这是仅在本机打开的管理页面。发信授权码由Windows加密保存，不会打进玩家包。</p><form id="form"><label>发信邮箱服务</label><select id="provider"><option value="qq">QQ邮箱</option><option value="163">163邮箱</option><option value="custom">其他SMTP</option></select><label>SMTP服务器</label><input id="host" value="smtp.qq.com" required><label>SMTP端口</label><select id="smtpPort"><option value="465">465 · TLS</option><option value="587">587 · STARTTLS</option></select><label>发信邮箱地址</label><input id="user" type="email" required autocomplete="username"><label>SMTP授权码</label><input id="password" type="password" required autocomplete="off"><small>在邮箱设置中开启SMTP并生成授权码。此处填写授权码，不是邮箱登录密码。</small><label>游戏服务本机端口</label><input id="port" type="number" value="2568" min="1024" max="65535" required><label>同时进行的排位比赛上限</label><input id="maxMatches" type="number" value="10" min="1" max="50" required><button id="submit">验证发信连接并启动</button></form><p id="error" role="status"></p><script>const el=id=>document.getElementById(id);const key=location.hash.slice(1);history.replaceState(null,'','/');el('provider').onchange=()=>{el('host').value=el('provider').value==='qq'?'smtp.qq.com':el('provider').value==='163'?'smtp.163.com':''};el('form').onsubmit=async e=>{e.preventDefault();el('submit').disabled=true;el('error').textContent='正在检查SMTP连接…';try{const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':key},body:JSON.stringify({port:Number(el('port').value),maxMatches:Number(el('maxMatches').value),smtp:{host:el('host').value.trim(),port:Number(el('smtpPort').value),user:el('user').value.trim(),from:el('user').value.trim(),password:el('password').value}})});const v=await r.json();if(!r.ok)throw Error(v.error);el('password').value='';el('error').textContent='配置已保存。服务启动后，终端会显示排位入口地址。';}catch(e){el('error').textContent=e.message;el('submit').disabled=false}};</script></html>`
