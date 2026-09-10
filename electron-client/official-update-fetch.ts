import { net, session } from 'electron'

let updateSession: Promise<Electron.Session> | undefined

/** Keep game traffic direct, but allow official downloads to use the system's
 * network settings. This is also electron-updater's isolated, cookie-free UI
 * partition. An explicit launcher override is useful for development networks;
 * no proxy address is built into a distributed client. */
export function prepareOfficialUpdateNetwork(): Promise<Electron.Session> {
  if (!updateSession) {
    updateSession = (async () => {
      const isolated = session.fromPartition('electron-updater', { cache: false })
      const proxy = process.env.RVB_UPDATE_PROXY?.trim()
      await isolated.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' })
      return isolated
    })().catch(error => { updateSession = undefined; throw error })
  }
  return updateSession
}

function describeNetworkError(error: Error): Error {
  if (error.message.includes('ERR_NAME_NOT_RESOLVED')) return new Error('无法解析 GitHub 更新地址，请检查网络或系统代理后重试（ERR_NAME_NOT_RESOLVED）')
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(error.message)) return new Error('无法连接更新代理，请检查代理服务后重试（' + error.message + '）')
  return error
}

/** Electron net.fetch rejects redirect:'manual' instead of exposing Location.
 * Use ClientRequest's redirect event so the core can validate every CDN hop.
 * No cookies, credentials or arbitrary renderer-provided request options. */
export async function officialUpdateFetch(url: string, init: RequestInit): Promise<Response> {
  const updateNetwork = await prepareOfficialUpdateNetwork()
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: updateNetwork, method: 'GET', redirect: 'manual', useSessionCookies: false })
    let finished = false
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    const cleanup = () => init.signal?.removeEventListener('abort', abort)
    const fail = (error: Error) => {
      if (finished) return
      error = describeNetworkError(error)
      finished = true
      cleanup()
      if (body) { try { body.error(error) } catch { /* Already cancelled. */ } }
      reject(error)
    }
    const abort = () => { fail(new Error('更新下载超时或已取消')); request.abort() }
    request.on('error', fail)
    request.on('redirect', (status, _method, location) => {
      if (finished) return
      finished = true
      cleanup()
      resolve(new Response(null, { status, headers: { location } }))
      request.abort()
    })
    request.on('response', response => {
      if (finished) return
      try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      if ([204, 205, 304].includes(response.statusCode)) {
        resolve(new Response(null, { status: response.statusCode, headers }))
        finished = true; cleanup(); request.abort(); return
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
          response.on('data', chunk => { if (!finished) { try { controller.enqueue(new Uint8Array(chunk)) } catch (error) { fail(error as Error); request.abort() } } })
          response.on('end', () => { if (!finished) { try { controller.close(); finished = true; cleanup() } catch (error) { fail(error as Error) } } })
          response.on('error', fail)
          response.on('aborted', () => fail(new Error('更新下载连接提前中断')))
        },
        cancel() { cleanup(); finished = true; request.abort() },
      })
      resolve(new Response(stream, { status: response.statusCode, headers }))
      } catch (error) { fail(error as Error); request.abort() }
    })
    for (const [key, value] of new Headers(init.headers).entries()) request.setHeader(key, value)
    request.setHeader('Cache-Control', 'no-cache, no-store')
    if (init.signal?.aborted) { abort(); return }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.end()
  })
}
