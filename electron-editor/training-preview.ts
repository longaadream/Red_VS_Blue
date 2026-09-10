import { BrowserWindow, protocol, session } from 'electron'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { createTrainingResources, type TrainingSnapshot } from './training-resources'

const scheme = 'rvb-editor-training'
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
const windows = new Set<BrowserWindow>()

export async function openTrainingPreview(appRoot: string, snapshot: TrainingSnapshot, hidden = false) {
  const resources = createTrainingResources(appRoot, snapshot)
  const id = randomUUID(), origin = `${scheme}://${id}`
  const isOwnUrl = (url: URL) => url.protocol === `${scheme}:` && url.hostname === id && !url.port && !url.username && !url.password
  const isolated = session.fromPartition(`editor-training-${id}`)
  // WebRTC bypasses webRequest: force TCP through our rejecting loopback proxy.
  const denyProxy = net.createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => { denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve) })
  const address = denyProxy.address() as net.AddressInfo
  let registered = false, cleaned = false, preview: BrowserWindow | undefined
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (preview) windows.delete(preview)
    denyProxy.close()
    if (registered) isolated.protocol.unhandle(scheme)
    void isolated.clearStorageData().catch(() => {})
  }
  try {
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port};socks=127.0.0.1:${address.port}`, proxyBypassRules: '<-loopback>' })
    isolated.on('will-download', event => event.preventDefault())
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') && !details.url.startsWith(`blob:${origin}/`) })
    })
    await isolated.protocol.handle(scheme, request => {
      const url = new URL(request.url)
      if (!isOwnUrl(url) || request.method !== 'GET') return new Response('Forbidden', { status: 403 })
      const result = resources(url.pathname)
      return result ? new Response(new Uint8Array(result.bytes), { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) : new Response('候选资源不存在', { status: 404 })
    })
    registered = true
    const title = `训练营 · 已接受版本 ${snapshot.contentHash.slice(0, 12)}`
    preview = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 700, title, show: !hidden,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: !hidden, offscreen: hidden } })
    windows.add(preview)
    preview.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    preview.setMenu(null)
    preview.on('page-title-updated', event => { event.preventDefault(); preview?.setTitle(title) })
    const allowedNavigation = (raw: string) => { try { const url = new URL(raw); return isOwnUrl(url) && ['/battle.html', '/training.html'].includes(url.pathname) && url.searchParams.get('mode') === 'training' } catch { return false } }
    preview.webContents.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault() })
    preview.webContents.on('will-frame-navigate', details => { if (!details.isMainFrame || !allowedNavigation(details.url)) details.preventDefault() })
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    preview.on('closed', cleanup)
    await preview.loadURL(`${origin}/battle.html?mode=training`)
    return { contentHash: snapshot.contentHash, windowId: preview.id }
  } catch (error) { if (preview && !preview.isDestroyed()) preview.destroy(); cleanup(); throw error }
}

export function closeTrainingPreviews() { for (const window of windows) if (!window.isDestroyed()) window.destroy() }
