import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('editorAPI', {
  listFiles:    (subdir: string) =>
    ipcRenderer.invoke('list-files', subdir),
  readFile:     (subdir: string, filename: string) =>
    ipcRenderer.invoke('read-file', subdir, filename),
  writeFile:    (subdir: string, filename: string, data: unknown) =>
    ipcRenderer.invoke('write-file', subdir, filename, data),
  createFile:   (subdir: string, id: string, data: unknown) =>
    ipcRenderer.invoke('create-file', subdir, id, data),
  openInEditor: (subdir: string, filename: string) =>
    ipcRenderer.invoke('open-in-editor', subdir, filename),
  listPveFiles: () => ipcRenderer.invoke('list-pve-files'),
  readPveFile: (relativePath: string) => ipcRenderer.invoke('read-pve-file', relativePath),
  writePveFile: (relativePath: string, data: unknown) =>
    ipcRenderer.invoke('write-pve-file', relativePath, data),
  openPveInEditor: (relativePath: string) => ipcRenderer.invoke('open-pve-in-editor', relativePath),
  listAssets: () => ipcRenderer.invoke('list-assets'),
  readAsset: (relativePath: string) => ipcRenderer.invoke('read-asset', relativePath),
  importAsset: (destinationPath: string, replace = false) =>
    ipcRenderer.invoke('import-asset', destinationPath, replace),
  copyText: (value: string) => ipcRenderer.invoke('copy-text', value),
  prepareWorkspacePackage: () => ipcRenderer.invoke('prepare-workspace-package'),
  contentOperation: (request: unknown) =>
    ipcRenderer.invoke('content-operation', request),
})
