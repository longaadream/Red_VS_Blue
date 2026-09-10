import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { CreativeWorkbench } from './workbench'
import { normalizeEditorContentOperationRequestV1, resolveEditorWorkspacePathV1 } from './content-pipeline-ipc'
import { GithubContentRelease } from './github-content-release'
import { trustedPublicationKeys } from './publication-identity'

type Result = { ok: boolean; report?: { identity?: Record<string, unknown>; refusal?: { code: string; message?: string; path?: string } }; reportPath?: string }
type Runner = (request: unknown) => Promise<unknown>
type Settings = { repository: string; token: string; keyFile: string }
type ArchiveRef = { contentHash: string; artifactId: string; sha256: string; publisherKeyId: string }
type Bundle = { contentHash: string; archiveSha256: string; indexSha256: string; notes: string; version: string; artifactId: string; publisherKeyId: string; snapshot: Record<string, string>; patchSha256?: string; chain?: { base: ArchiveRef; patches: ArchiveRef[] } }
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** Trusted coordinator. It only packages materialized accepted snapshots, never sources/current-workspace. */
export class ResourceRelease {
  constructor(private workspace: string, private appRoot: string, private privateRoot: string, private run: Runner) {}
  private async step(request: unknown): Promise<Result> {
    const result = await this.run(request) as Result
    if (!result?.ok) {
      const refusal = result?.report?.refusal
      throw new Error(`资源包未通过检查：${refusal?.code || 'UNKNOWN'}${refusal?.path ? ' · ' + refusal.path : ''}。${refusal?.message || ''} 请修复此项检查后重试，未上传新的资源包。`)
    }
    return result
  }
  private buildRequest(source: string, output: string, version: string, notes: string) {
    return normalizeEditorContentOperationRequestV1(this.workspace, this.appRoot, {
      operation: 'build', taskId: 'RED-200', channel: 'authoring', mode: 'snapshot', source, output,
      packageId: 'rvb.official-content', publisherId: 'rvb.official', displayName: 'RED vs BLUE 资源更新', version, ...(notes ? { description: notes.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, '') } : {}),
    })
  }
  private freeze(accepted: ReturnType<CreativeWorkbench['materializeAccepted']>) {
    const root = path.join(this.privateRoot, 'staging', randomUUID())
    fs.mkdirSync(root, { recursive: true })
    for (const [relative, expectedHash] of Object.entries(accepted.snapshot)) {
      const input = resolveEditorWorkspacePathV1(this.workspace, `${accepted.source}/${relative}`, 'accepted content')
      const bytes = fs.readFileSync(input)
      if (hash(bytes) !== expectedHash) throw new Error('候选内容在准备期间发生变化，未构建或上传')
      const destination = path.join(root, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, bytes, { flag: 'wx' })
    }
    return root
  }
  async export(id: string, expectedAcceptedHash: string, notes: string) {
    if (typeof notes !== 'string' || notes.length > 4000) throw new Error('更新说明不能超过 4000 字符')
    const accepted = new CreativeWorkbench(this.workspace, this.appRoot).materializeAccepted(id, expectedAcceptedHash)
    const output = `archives/content-${randomUUID()}.rvbpack`
    const version = `0.0.${Date.now()}`
    const sourceDir = this.freeze(accepted)
    const outputArchive = path.join(path.dirname(sourceDir), `export-${randomUUID()}.rvbpack`)
    await this.step({ ...this.buildRequest(accepted.source, output, version, notes), sourceDir, outputArchive })
    return { path: outputArchive, contentHash: accepted.contentHash, version, signed: false, published: false }
  }
  async publish(id: string, expectedAcceptedHash: string, notes: string, settings: Settings, fetcher: ConstructorParameters<typeof GithubContentRelease>[0], progress: (stage: string) => void) {
    settings = { ...settings, repository: String(settings.repository).toLowerCase() }
    fs.mkdirSync(this.privateRoot, { recursive: true })
    const lock = path.join(this.privateRoot, `publish-${hash(String(settings.repository).toLowerCase())}.lock`)
    let descriptor: number
    try { descriptor = fs.openSync(lock, 'wx') } catch { throw new Error('另一个编辑器正在发布到此仓库；若上次意外退出，请先检查发布记录再清理对应 publish 锁文件') }
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
      return await this.publishLocked(id, expectedAcceptedHash, notes, settings, fetcher, progress)
    } finally { fs.closeSync(descriptor); fs.unlinkSync(lock) }
  }
  private async publishLocked(id: string, expectedAcceptedHash: string, notes: string, settings: Settings, fetcher: ConstructorParameters<typeof GithubContentRelease>[0], progress: (stage: string) => void) {
    if (typeof notes !== 'string' || notes.length > 4000) throw new Error('更新说明不能超过 4000 字符')
    const github = new GithubContentRelease(fetcher, settings.repository, settings.token)
    if (!settings.keyFile || !path.isAbsolute(settings.keyFile) || fs.lstatSync(settings.keyFile).isSymbolicLink() || !fs.statSync(settings.keyFile).isFile()) throw new Error('请在发布设置中选择已有的官方签名密钥')
    const keyFile = fs.realpathSync(settings.keyFile)
    const workspace = fs.realpathSync(this.workspace)
    const relativeKey = path.relative(workspace, keyFile)
    if (!relativeKey.startsWith('..' + path.sep) && relativeKey !== '..' && !path.isAbsolute(relativeKey)) throw new Error('签名密钥必须放在外部 AI 内容工作区之外')
    progress('检查已接受内容')
    const accepted = new CreativeWorkbench(this.workspace, this.appRoot).materializeAccepted(id, expectedAcceptedHash)
    fs.mkdirSync(this.privateRoot, { recursive: true })
    const directory = path.join(this.privateRoot, hash(settings.repository + '\0' + accepted.contentHash))
    fs.mkdirSync(directory, { recursive: true })
    const recordPath = path.join(directory, 'bundle.json')
    const previousPath = path.join(this.privateRoot, `previous-${hash(settings.repository)}.json`)
    let bundle: Bundle
    if (fs.existsSync(recordPath)) {
      bundle = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
      if (bundle.contentHash !== accepted.contentHash) throw new Error('本地发布记录身份不符')
    } else {
      progress('生成并校验更新文件')
      const nonce = randomUUID()
      const version = `0.0.${Date.now()}`
      const output = `archives/content-${nonce}.rvbpack`
      const sourceDir = this.freeze(accepted)
      const artifactDirectory = path.join(directory, nonce)
      fs.mkdirSync(artifactDirectory)
      const build = { ...this.buildRequest(accepted.source, output, version, notes), sourceDir, outputArchive: path.join(artifactDirectory, 'unsigned.rvbpack') }
      await this.step(build)
      const signedPath = path.join(artifactDirectory, 'content.rvbpack')
      const signedResult = await this.step({ ...build, operation: 'sign', channel: 'qa', inputArchive: build.outputArchive, outputArchive: signedPath, keyFile, command: { name: 'sign', args: ['<accepted-snapshot>', '<redacted-key>'] } })
      const keyId = signedResult.report?.identity?.publisherKeyId
      if (typeof keyId !== 'string' || !/^[a-f0-9]{64}$/.test(keyId)) throw new Error('签名身份校验失败')
      const checked = await this.step({ ...build, operation: 'validate', channel: 'qa', archive: signedPath, trustedPublisherKeyIds: [keyId], patches: [], command: { name: 'validate', args: ['<signed-accepted-snapshot>'] } })
      const bytes = fs.readFileSync(signedPath)
      if (bytes.length > 32 * 1024 * 1024) throw new Error('资源包超过当前客户端 32 MiB 限制，未上传')
      let patch: { archive: string; sha256: string; parentProfileHash: string; resolvedProfileHash: string } | undefined
      let chain: Bundle['chain'] = { base: { contentHash: accepted.contentHash, artifactId: nonce, sha256: hash(bytes), publisherKeyId: keyId }, patches: [] }
      if (fs.existsSync(previousPath)) {
        const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8')) as Bundle
        if (!/^[a-f0-9]{64}$/.test(previous.contentHash) || !/^[a-f0-9-]{36}$/.test(previous.artifactId) || !/^[a-f0-9]{64}$/.test(previous.publisherKeyId)) throw new Error('上一发布版本记录无效，未上传')
        if (previous.contentHash !== accepted.contentHash && (previous.chain?.patches.length ?? 0) < 256) {
          progress('自动生成相对于上一发布版本的补丁')
          const previousArchive = path.join(this.privateRoot, hash(settings.repository + '\0' + previous.contentHash), previous.artifactId, 'content.rvbpack')
          if (hash(fs.readFileSync(previousArchive)) !== previous.archiveSha256) throw new Error('上一发布包校验失败，无法生成补丁')
          const previousChain = previous.chain ?? { base: { contentHash: previous.contentHash, artifactId: previous.artifactId, sha256: previous.archiveSha256, publisherKeyId: previous.publisherKeyId }, patches: [] }
          const chainPath = (ref: ArchiveRef, filename: string) => {
            if (!/^[a-f0-9]{64}$/.test(ref.contentHash) || !/^[a-f0-9-]{36}$/.test(ref.artifactId) || !/^[a-f0-9]{64}$/.test(ref.sha256) || !/^[a-f0-9]{64}$/.test(ref.publisherKeyId)) throw new Error('历史补丁链记录无效')
            const file = path.join(this.privateRoot, hash(settings.repository + '\0' + ref.contentHash), ref.artifactId, filename)
            if (hash(fs.readFileSync(file)) !== ref.sha256) throw new Error('历史补丁链文件校验失败')
            return file
          }
          const chainBase = chainPath(previousChain.base, 'content.rvbpack')
          const chainPatches = previousChain.patches.map(ref => chainPath(ref, 'content-patch.rvbpack'))
          const trust = [...new Set([keyId, previousChain.base.publisherKeyId, ...previousChain.patches.map(ref => ref.publisherKeyId)])]
          const parent = await this.step({ ...build, operation: 'resolve', channel: 'qa', base: { kind: 'archive', archive: chainBase }, patches: chainPatches, trustedPublisherKeyIds: trust, command: { name: 'resolve', args: ['<previous-published-chain>'] } })
          const parentProfileHash = parent.report?.identity?.resolvedProfileHash
          if (typeof parentProfileHash !== 'string') throw new Error('无法确定上一发布包的内容身份')
          const patchRoot = path.join(artifactDirectory, 'patch-source')
          fs.mkdirSync(patchRoot)
          const paths = [...new Set([...Object.keys(previous.snapshot), ...Object.keys(accepted.snapshot)])].sort((a, b) => {
            const left = Array.from(a, value => value.codePointAt(0)!), right = Array.from(b, value => value.codePointAt(0)!)
            for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index] - right[index]
            return left.length - right.length
          })
          const operations: Record<string, string>[] = []
          for (const relative of paths) {
            if (previous.snapshot[relative] === accepted.snapshot[relative]) continue
            if (accepted.snapshot[relative]) {
              const original = resolveEditorWorkspacePathV1(sourceDir, relative, 'patch source')
              const target = resolveEditorWorkspacePathV1(patchRoot, relative, 'patch target', 'write')
              fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL)
              operations.push(previous.snapshot[relative] ? { op: 'replace', targetPath: relative, sourcePath: relative, expectedHash: previous.snapshot[relative] } : { op: 'add', targetPath: relative, sourcePath: relative })
            } else operations.push({ op: 'remove', targetPath: relative, expectedHash: previous.snapshot[relative] })
          }
          const unsignedPatch = path.join(artifactDirectory, 'patch-unsigned.rvbpack'), signedPatch = path.join(artifactDirectory, 'content-patch.rvbpack')
          await this.step({ ...build, mode: 'patch', sourceDir: patchRoot, outputArchive: unsignedPatch, parentProfileHash, operations, base: { kind: 'archive', archive: chainBase }, patches: chainPatches })
          await this.step({ ...build, operation: 'sign', channel: 'qa', inputArchive: unsignedPatch, outputArchive: signedPatch, keyFile, command: { name: 'sign', args: ['<automatic-patch>', '<redacted-key>'] } })
          const resolved = await this.step({ ...build, operation: 'resolve', channel: 'qa', base: { kind: 'archive', archive: chainBase }, patches: [...chainPatches, signedPatch], trustedPublisherKeyIds: trust, command: { name: 'resolve', args: ['<previous-chain>', '<automatic-patch>'] } })
          const resolvedProfileHash = resolved.report?.identity?.resolvedProfileHash
          if (typeof resolvedProfileHash !== 'string') throw new Error('补丁应用验证失败')
          const patchBytes = fs.readFileSync(signedPatch)
          if (patchBytes.length > 32 * 1024 * 1024) throw new Error('补丁超过当前客户端大小限制')
          patch = { archive: 'content-patch.rvbpack', sha256: hash(patchBytes), parentProfileHash, resolvedProfileHash }
          chain = { base: previousChain.base, patches: [...previousChain.patches, { contentHash: accepted.contentHash, artifactId: nonce, sha256: patch.sha256, publisherKeyId: keyId }] }
        }
      }
      const index = Buffer.from(JSON.stringify({ schema: 'rvb-content-release/v1', channel: 'test', version, contentHash: accepted.contentHash, archive: 'content.rvbpack', archiveSha256: hash(bytes), identity: checked.report?.identity, distribution: patch ? 'snapshot-and-patch' : 'full-snapshot', ...(patch ? { patch } : {}), automaticClientDiscovery: true }, null, 2) + '\n')
      fs.writeFileSync(path.join(artifactDirectory, 'content-update.json'), index, { flag: 'wx' })
      bundle = { contentHash: accepted.contentHash, archiveSha256: hash(bytes), indexSha256: hash(index), notes, version, artifactId: nonce, snapshot: accepted.snapshot, publisherKeyId: keyId, chain, ...(patch ? { patchSha256: patch.sha256 } : {}) }
      fs.writeFileSync(recordPath, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' })
    }
    if (!/^[a-f0-9-]{36}$/.test(bundle.artifactId)) throw new Error('发布缓存记录无效')
    const archive = fs.readFileSync(path.join(directory, bundle.artifactId, 'content.rvbpack'))
    const index = fs.readFileSync(path.join(directory, bundle.artifactId, 'content-update.json'))
    if (hash(archive) !== bundle.archiveSha256 || hash(index) !== bundle.indexSha256) throw new Error('本地待发布文件发生变化，未上传')
    // Recheck cached retries as well: a client upgrade may have revoked this signer.
    const verified = await this.step({
      ...this.buildRequest(accepted.source, 'archives/publish-check.rvbpack', bundle.version, bundle.notes),
      operation: 'validate', channel: 'qa', archive: path.join(directory, bundle.artifactId, 'content.rvbpack'),
      trustedPublisherKeyIds: [bundle.publisherKeyId], patches: [], command: { name: 'validate', args: ['<publish-check>'] },
    })
    const capabilities = verified.report?.identity?.capabilities
    let chainHasScripts = false
    if (bundle.patchSha256) {
      if (!bundle.chain || !bundle.chain.patches.length) throw new Error('补丁来源链缺失，未上传')
      const chainPath = (ref: ArchiveRef, filename: string) => {
        if (!/^[a-f0-9]{64}$/.test(ref.contentHash) || !/^[a-f0-9-]{36}$/.test(ref.artifactId) || !/^[a-f0-9]{64}$/.test(ref.sha256) || !/^[a-f0-9]{64}$/.test(ref.publisherKeyId)) throw new Error('历史补丁链记录无效')
        const file = path.join(this.privateRoot, hash(settings.repository + '\0' + ref.contentHash), ref.artifactId, filename)
        if (hash(fs.readFileSync(file)) !== ref.sha256) throw new Error('历史补丁链文件校验失败')
        return file
      }
      const chainChecked = await this.step({
        ...this.buildRequest(accepted.source, 'archives/chain-check.rvbpack', bundle.version, bundle.notes),
        operation: 'resolve', channel: 'qa', base: { kind: 'archive', archive: chainPath(bundle.chain.base, 'content.rvbpack') },
        patches: bundle.chain.patches.map(ref => chainPath(ref, 'content-patch.rvbpack')),
        trustedPublisherKeyIds: [...new Set([bundle.chain.base.publisherKeyId, ...bundle.chain.patches.map(ref => ref.publisherKeyId)])],
        command: { name: 'resolve', args: ['<publish-chain-check>'] },
      })
      const chainCapabilities = chainChecked.report?.identity?.sourceCapabilities
      chainHasScripts = Array.isArray(chainCapabilities) && chainCapabilities.includes('trusted-executable-content')
      if (!Array.isArray(chainCapabilities)) throw new Error('打包工具缺少补丁来源能力报告，请升级编辑器；未上传')
    }
    if (chainHasScripts || (Array.isArray(capabilities) && capabilities.includes('trusted-executable-content'))) {
      const trusted = trustedPublicationKeys(this.appRoot)
      const keys = [bundle.publisherKeyId, ...(bundle.chain ? [bundle.chain.base.publisherKeyId, ...bundle.chain.patches.map(ref => ref.publisherKeyId)] : [])]
      if (keys.some(key => !trusted.includes(key))) throw new Error('此签名身份尚未被当前客户端版本信任。请先将发行者公钥 ID 配入客户端并发布一次客户端升级，然后再发布脚本资源包；本次未上传。')
    }
    const assets = [{ name: 'content.rvbpack', bytes: archive }, { name: 'content-update.json', bytes: index }]
    if (bundle.patchSha256) {
      const patchBytes = fs.readFileSync(path.join(directory, bundle.artifactId, 'content-patch.rvbpack'))
      if (hash(patchBytes) !== bundle.patchSha256) throw new Error('本地补丁内容已变化，未上传')
      assets.push({ name: 'content-patch.rvbpack', bytes: patchBytes })
    }
    const result = await github.publish({ contentHash: bundle.contentHash, notes: bundle.notes, assets }, progress)
    fs.writeFileSync(path.join(directory, `published-${randomUUID()}.json`), JSON.stringify({ ...result, version: bundle.version, publishedAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
    const previousVersion = fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath, 'utf8')).version : '0.0.0'
    if (Number(bundle.version.split('.')[2]) >= Number(String(previousVersion).split('.')[2])) {
      const temporary = previousPath + '.' + randomUUID() + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(bundle), { flag: 'wx' }); fs.renameSync(temporary, previousPath)
    }
    return { ...result, version: bundle.version, hasPatch: !!bundle.patchSha256, automaticClientDiscovery: true }
  }
}
