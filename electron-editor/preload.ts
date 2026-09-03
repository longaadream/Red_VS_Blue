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
  contentOperation: (request: unknown) =>
    ipcRenderer.invoke('content-operation', request),
})
