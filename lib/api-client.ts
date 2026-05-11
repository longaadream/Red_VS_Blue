/**
 * api-client.ts
 * 多人游戏 API 路由辅助。
 * 在 Electron 客户端中，多人 API 调用需要路由到远程服务器。
 * 远程服务器地址保存在 sessionStorage 中（由 OnlineGate 设置）。
 */

const SESSION_KEY = 'rvb_remote_server_url'

/** 读取已保存的远程服务器地址（无则返回空字符串） */
export function getRemoteServerUrl(): string {
  if (typeof window === 'undefined') return ''
  return (
    sessionStorage.getItem(SESSION_KEY) ||
    localStorage.getItem(SESSION_KEY) ||
    localStorage.getItem('rvb_server_url') ||   // Android index.html 原 key
    ''
  )
}

/** 保存远程服务器地址到 sessionStorage */
export function setRemoteServerUrl(url: string): void {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(SESSION_KEY, url.replace(/\/$/, ''))
}

/** 清除远程服务器地址 */
export function clearRemoteServerUrl(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(SESSION_KEY)
}

/**
 * 多人游戏 API 专用 fetch。
 * 若已设置远程服务器地址则自动加远程前缀；否则退回到相对路径（本地调试用）。
 */
export async function mpFetch(path: string, options?: RequestInit): Promise<Response> {
  const base = getRemoteServerUrl()
  const url = base ? `${base}${path}` : path
  return fetch(url, options)
}
