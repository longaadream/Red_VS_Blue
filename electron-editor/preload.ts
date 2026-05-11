import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('editorAPI', {
  listFiles:    (subdir: string) =>
    ipcRenderer.invoke('list-files', subdir),
  readFile:     (subdir: string, filename: string) =>
    ipcRenderer.invoke('read-file', subdir, filename),
  writeFile:    (subdir: string, filename: string, data: unknown) =>
    ipcRenderer.invoke('write-file', subdir, filename, data),
  openInEditor: (subdir: string, filename: string) =>
    ipcRenderer.invoke('open-in-editor', subdir, filename),
  runBuild:     (args: { name: string; version: string; desc: string }) =>
    ipcRenderer.invoke('run-build', args),
  onBuildOutput: (cb: (payload: { line?: string; done?: boolean; exitCode?: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload as any)
    ipcRenderer.on('build-output', handler)
    return () => ipcRenderer.removeListener('build-output', handler)
  },
})
