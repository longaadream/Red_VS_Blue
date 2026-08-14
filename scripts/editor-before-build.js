// The editor main process uses only Electron and Node built-ins. Its external
// resource-pack script resolves the small JSZip runtime copied by extraResources.
// Returning false prevents electron-builder from collecting every production
// dependency from the root Next.js application into the editor ASAR.
module.exports = async function handleEditorDependenciesExternally() {
  return false
}
