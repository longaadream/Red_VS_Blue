import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readProfileArchiveV1 } from '../lib/content-pipeline/runtime/profile-archive'
import { contentPolicyForChannelV1, parseArchiveManifestV1 } from '../lib/content-pipeline/tooling/archive'
import { resolveProfileV1 } from '../lib/content-pipeline/core/resolver'
import { openContentProject } from './content-project'
import { CreativeWorkbench } from './workbench'

const MAX_ARCHIVE = 32 * 1024 * 1024
function readArchive(file: string) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE) throw new Error('请选择不超过 32 MiB 的普通 .rvbpack 文件')
  const bytes = fs.readFileSync(file)
  if (bytes.length > MAX_ARCHIVE) throw new Error('资源包超过 32 MiB')
  const source = readProfileArchiveV1(bytes)
  return { bytes, source, manifest: parseArchiveManifestV1(source), sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Runs in the editor utility process. Only native file pickers supply these paths. */
export function importResourceProject(input: { archive: string; parent: string; baseArchive?: string }) {
  const archive = readArchive(input.archive)
  if (archive.manifest.kind === 'patch' && !input.baseArchive) return { needsBase: true as const }
  const base = archive.manifest.kind === 'patch' ? readArchive(input.baseArchive!) : archive
  if (base.manifest.kind !== 'snapshot') throw new Error('请选择完整原包；当前导入支持完整包，或完整包加一个匹配的补丁')
  // Authoring permits unsigned source packs, but never skips integrity, signature,
  // compatibility, passive-asset or executable-content validation.
  const policy = contentPolicyForChannelV1('local-dev')
  const view = resolveProfileV1({ base: { source: base.source, policy }, patches: archive === base ? [] : [{ source: archive.source, policy }] })
  const parent = fs.realpathSync(input.parent)
  if (!fs.statSync(parent).isDirectory()) throw new Error('请选择保存项目的文件夹')
  // Validate every output before creating any project. A unique destination plus
  // exclusive writes means imports never merge into or overwrite an old project.
  const files = view.files.map(file => {
    const relative = file.path
    if (!/^(data\/.*\.json|images\/.*\.(png|jpe?g|webp|svg))$/i.test(relative)
      || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('不支持的资源路径：' + relative)
    const bytes = view.readFile(relative)
    if (!bytes) throw new Error('资源文件缺失：' + relative)
    return { relative, bytes }
  })
  const root = path.join(parent, 'rvb-import-' + randomUUID())
  fs.mkdirSync(root)
  try {
    for (const file of files) {
      const destination = path.join(root, file.relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, file.bytes, { flag: 'wx' })
    }
    const initializedFiles: string[] = []
    for (const collection of ['pieces', 'skills', 'cards', 'rules']) {
      const directory = path.join(root, 'data', collection)
      fs.mkdirSync(directory, { recursive: true })
      const manifest = path.join(directory, 'manifest.json')
      if (!fs.existsSync(manifest)) {
        // Empty collection scaffolding is required by editor authoring checks.
        fs.writeFileSync(manifest, '[]\n', { flag: 'wx' })
        initializedFiles.push(`data/${collection}/manifest.json`)
      }
    }
    for (const directory of ['data/pve', 'images', 'archives', 'keys', 'reports', 'sources']) fs.mkdirSync(path.join(root, directory), { recursive: true })
    const originals = archive === base ? [archive] : [base, archive]
    for (const original of originals) fs.writeFileSync(path.join(root, 'archives', original.sha256 + '.rvbpack'), original.bytes, { flag: 'wx' })
    fs.writeFileSync(path.join(root, 'rvb-content-project.json'), JSON.stringify({ schema: 'rvb-content-project/v1', template: 'import', importedAt: new Date().toISOString(), initializedFiles, resolvedProfileHash: view.profile.resolvedProfileHash, originals: originals.map(item => ({ sha256: item.sha256, packageId: item.manifest.packageId, version: item.manifest.version, signed: !!item.source.signatureBytes })) }, null, 2) + '\n', { flag: 'wx' })
    openContentProject(root)
    const state = new CreativeWorkbench(root, root).create({ title: '更新导入的资源包', brief: '在导入原包的基础上修改内容，逐项检查并接受修改。', criteria: '保留原包基准；只发布已接受且通过资源校验的修改。' })
    return { needsBase: false as const, root, taskId: state.task.id, files: files.length, signed: originals.every(item => !!item.source.signatureBytes) }
  } catch (error) {
    // Retain partial data for inspection instead of recursively deleting user paths.
    throw new Error(`导入未完成，未切换项目。临时目录：${root}。${(error as Error).message}`)
  }
}
