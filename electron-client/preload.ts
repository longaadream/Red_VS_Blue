import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // 读取已保存的远程服务器地址
  getRemoteUrl: () => ipcRenderer.invoke('get-remote-url'),
  // 保存远程服务器地址（连接成功后调用，不跳转页面）
  setRemoteUrl: (url: string) => ipcRenderer.invoke('set-remote-url', url),
  // 连接服务器并在新窗口中打开游戏
  connectServer: (url: string) => ipcRenderer.invoke('connect-server', url),
  // 清除远程服务器地址
  clearRemoteUrl: () => ipcRenderer.invoke('clear-remote-url'),
  // 返回离线模式（清除地址）
  goOffline: () => ipcRenderer.invoke('go-offline'),
  openLocalGame: () => ipcRenderer.invoke('open-local-game'),
  // 查询当前模式
  getMode: () => ipcRenderer.invoke('get-mode'),
  // 重启本地服务器
  restartServer: () => ipcRenderer.invoke('restart-server'),
  // 资源包管理（Electron 端用文件系统替代 Service Worker Cache）
  packGetFilePath: (file: File) => webUtils.getPathForFile(file),
  packImportFromPath: (zipPath: string) => ipcRenderer.invoke('pack-import-from-path', zipPath),
  packImportData: (base64: string, filename: string) => ipcRenderer.invoke('pack-import-data', base64, filename),
  packActivate: (targetProfileHash: string) => ipcRenderer.invoke('pack-activate', targetProfileHash),
  packRollback: (target: 'previous-stable' | 'bundled-base') => ipcRenderer.invoke('pack-rollback', target),
  packClear: () => ipcRenderer.invoke('pack-clear'),
  packList: () => ipcRenderer.invoke('pack-list'),
  // 获取本机局域网 IP（供 LAN 自动发现）
  getLanIps: () => ipcRenderer.invoke('get-lan-ips'),
  // 获取主机信息（端口 + LAN IPs），Electron 客户端内嵌服务器用
  getHostInfo: () => ipcRenderer.invoke('get-host-info'),
  // UDP LAN 主机广播（我当主机时启动，stopHostBroadcast 时停止）
  startHostBroadcast: () => ipcRenderer.invoke('start-host-broadcast'),
  stopHostBroadcast: () => ipcRenderer.invoke('stop-host-broadcast'),
  // UDP 主机发现：触发后 Java/Node 后台监听，结果通过 onUdpHostFound 回调推送
  startDiscoverHosts: (timeoutMs: number) => ipcRenderer.invoke('start-discover-hosts', timeoutMs),
  onUdpHostFound: (cb: (info: any) => void) => ipcRenderer.on('udp-host-found', (_e, info) => cb(info)),
  onUdpDiscoveryDone: (cb: () => void) => ipcRenderer.on('udp-discovery-done', () => cb()),
  offUdpDiscovery: () => {
    ipcRenderer.removeAllListeners('udp-host-found')
    ipcRenderer.removeAllListeners('udp-discovery-done')
  },
  // 资源包上传（服务端 dashboard 用）
  uploadResourcePack: (filePath: string) => ipcRenderer.invoke('upload-resource-pack', filePath),
  uploadResourcePackData: (base64: string, filename: string) => ipcRenderer.invoke('upload-resource-pack-data', base64, filename),
  getResourcePackStatus: () => ipcRenderer.invoke('get-resource-pack-status'),
})
