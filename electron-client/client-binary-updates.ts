export type BinaryUpdateStatus = { phase: string; message: string; version?: string; percent?: number }
export interface BinaryUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on: (event: string, listener: (info: { percent?: number; version?: string }) => void) => unknown
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (silent: boolean, restart: boolean) => void
}

/** The generated app-update.yml pins the official GitHub repository. Only stable
 * client releases contain latest.yml; content-test-* releases are prereleases. */
export class ClientBinaryUpdates {
  status: BinaryUpdateStatus = { phase: 'idle', message: '等待检查客户端版本' }
  private running?: Promise<void>
  private downloaded = false
  constructor(private updater: BinaryUpdater | null, private changed: () => void, private prepareNetwork: () => Promise<unknown> = async () => {}) {
    if (!updater) { this.status = { phase: 'unsupported', message: '当前为开发版或非 Windows 安装版；客户端自动更新需使用新版安装包' }; return }
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('error', () => { this.downloaded = false; this.set('error', '客户端更新失败，当前版本继续可用；可稍后重试') })
    updater.on('download-progress', info => this.set('downloading', '正在下载客户端更新', undefined, Math.max(0, Math.min(100, Math.round(info.percent || 0)))))
    updater.on('update-downloaded', info => { this.downloaded = true; this.set('downloaded', '客户端更新已下载，返回主菜单后可重启安装', info.version) })
  }
  private set(phase: string, message: string, version?: string, percent?: number) {
    this.status = { phase, message, ...(version ? { version } : {}), ...(percent !== undefined ? { percent } : {}) }; this.changed()
  }
  check(): Promise<void> {
    if (!this.updater || this.downloaded) return Promise.resolve()
    if (this.running) return this.running
    this.running = (async () => {
      this.set('checking', '正在检查客户端版本')
      await this.prepareNetwork()
      // autoDownload is disabled so the returned check and download are one
      // observable operation; no unhandled background download rejection.
      const result = await this.updater!.checkForUpdates() as { isUpdateAvailable?: boolean; updateInfo?: { version: string } } | null
      if (result?.isUpdateAvailable) {
        this.set('downloading', '正在下载客户端更新', result.updateInfo?.version)
        await this.updater!.downloadUpdate()
      } else this.set('current', '客户端已是当前稳定版本')
    })().catch(() => this.set('error', '暂时无法获取客户端更新，当前版本继续可用；可稍后重试')).finally(() => { this.running = undefined })
    return this.running
  }
  isReady() { return this.downloaded && this.status.phase === 'downloaded' }
  install() {
    if (!this.isReady() || !this.updater) throw new Error('客户端安装包尚未下载完成')
    this.updater.quitAndInstall(false, true)
  }
}
