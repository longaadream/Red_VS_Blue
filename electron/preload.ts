import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  startServer: () => ipcRenderer.invoke('start-server'),
  getLobby: () => ipcRenderer.invoke('get-lobby'),
  getRooms: () => ipcRenderer.invoke('get-rooms'),
  deleteRoom: (roomId: string) => ipcRenderer.invoke('delete-room', roomId),
  getResourcePackStatus: () => ipcRenderer.invoke('get-resource-pack-status'),
  uploadResourcePackData: (base64: string, fileName: string) => ipcRenderer.invoke('upload-resource-pack-data', base64, fileName),
  activateResourcePack: (targetProfileHash: string) => ipcRenderer.invoke('activate-resource-pack', targetProfileHash),
  rollbackResourcePack: (target: 'previous-stable' | 'bundled-base') => ipcRenderer.invoke('rollback-resource-pack', target),
  onServerStatus: (cb: (data: { running: boolean; code?: number }) => void) => {
    ipcRenderer.on('server-status', (_e, data) => cb(data))
  },
})
