import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('editorAPI', {
  importCode: (mode: 'files' | 'folder') => ipcRenderer.invoke('code-import', mode),
  analyzeFlow: (category: string, document: unknown) => ipcRenderer.invoke('source-flow-analyze', category, document),
  editFlowNode: (category: string, document: unknown, request: unknown) => ipcRenderer.invoke('source-flow-edit', category, document, request),
  visualCatalog: () => ipcRenderer.invoke('visual-catalog'),
  workbenchList: () => ipcRenderer.invoke('workbench-list'),
  workbenchCreate: (input: unknown) => ipcRenderer.invoke('workbench-create', input),
  workbenchInspect: (id: string) => ipcRenderer.invoke('workbench-inspect', id),
  workbenchAccept: (id: string, input: unknown) => ipcRenderer.invoke('workbench-accept', id, input),
  workbenchRevert: (id: string, input: unknown) => ipcRenderer.invoke('workbench-revert', id, input),
  workbenchImage: (id: string, relative: string, side: 'before' | 'after', hash: string, acceptedHash: string) => ipcRenderer.invoke('workbench-image', id, relative, side, hash, acceptedHash),
  workbenchExport: (id: string, hash: string, notes: string) => ipcRenderer.invoke('workbench-export', id, hash, notes),
  workbenchTraining: (id: string, hash: string) => ipcRenderer.invoke('workbench-training', id, hash),
  workbenchPublish: (id: string, hash: string, notes: string) => ipcRenderer.invoke('workbench-publish', id, hash, notes),
  publicationSettings: () => ipcRenderer.invoke('publication-settings'),
  publicationSaveSettings: (input: unknown) => ipcRenderer.invoke('publication-save-settings', input),
  publicationChooseKey: () => ipcRenderer.invoke('publication-choose-key'),
  publicationCreateKey: () => ipcRenderer.invoke('publication-create-key'),
  onPublicationProgress: (callback: (value: { taskId: string; stage: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { taskId: string; stage: string }) => callback(value)
    ipcRenderer.on('publication-progress', listener)
    return () => ipcRenderer.removeListener('publication-progress', listener)
  },
  workbenchCheck: (id: string) => ipcRenderer.invoke('workbench-check', id),
  workbenchFeedback: (id: string, input: unknown) => ipcRenderer.invoke('workbench-feedback', id, input),
  workbenchScenario: (id: string, input: unknown) => ipcRenderer.invoke('workbench-scenario', id, input),
  workbenchKeep: (id: string, hash: string) => ipcRenderer.invoke('workbench-keep', id, hash),
  workbenchHandoff: (id: string) => ipcRenderer.invoke('workbench-handoff', id),
  projectInfo: () => ipcRenderer.invoke('project-info'),
  revealProject: () => ipcRenderer.invoke('project-reveal'),
  importProject: () => ipcRenderer.invoke('project-import'),
  selectProject: (mode: 'open' | 'official' | 'blank') => ipcRenderer.invoke('project-select', mode),
  readDocument: (subdir: string, filename: string) => ipcRenderer.invoke('read-document', subdir, filename),
  writeDocument: (subdir: string, filename: string, data: unknown, revision: string) => ipcRenderer.invoke('write-document', subdir, filename, data, revision),
  readPveDocument: (relativePath: string) => ipcRenderer.invoke('read-pve-document', relativePath),
  writePveDocument: (relativePath: string, data: unknown, revision: string) => ipcRenderer.invoke('write-pve-document', relativePath, data, revision),
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
