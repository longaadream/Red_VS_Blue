import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { OfficialError } from './accounts'

type Entry = { path: string; bytes: number; sha256: string }
type Manifest = { version: 1; product: 'rvb-official-postgres'; createdAt: string; files: Entry[] }
const validId = /^[0-9]{13}-[a-f0-9-]{36}$/
const exists = async (file: string) => { try { await fs.lstat(file); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }
async function directory(file: string) { const s = await fs.lstat(file); if (!s.isDirectory() || s.isSymbolicLink()) throw new OfficialError('备份目录不能是链接', 409) }
async function inventory(root: string): Promise<Entry[]> {
  await directory(root)
  const files: Entry[] = []; let total = 0
  async function walk(relative: string) {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      const rel = path.posix.join(relative, name), file = path.join(root, rel), stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) throw new OfficialError('备份中不允许符号链接', 409)
      if (files.length >= 100000) throw new OfficialError('备份文件数量超过上限', 409)
      if (stat.isDirectory()) { files.push({ path: rel + '/', bytes: 0, sha256: 'directory' }); await walk(rel) }
      else if (stat.isFile()) {
        total += stat.size
        if (files.length >= 100000 || total > 10 * 1024 ** 3) throw new OfficialError('备份超过首版10GB或10万文件上限', 409)
        const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk)
        files.push({ path: rel, bytes: stat.size, sha256: hash.digest('hex') })
      } else throw new OfficialError('备份包含不支持的文件类型', 409)
    }
  }
  await walk('')
  if (!files.some(f => f.path === 'credential.bin') || !files.some(f => f.path === 'data/PG_VERSION') || files.some(f => f.path === 'data/postmaster.pid')) throw new OfficialError('数据库未正常停止或备份缺少必要文件', 409)
  return files
}

/** Only local, same-Windows-user backups. SMTP settings and admin capabilities stay outside. */
export class OfficialBackups {
  readonly root: string
  private readonly backups: string
  private readonly data: string
  private readonly intent: string
  constructor(root: string) {
    this.root = path.resolve(root); this.backups = path.join(this.root, 'backups'); this.data = path.join(this.root, 'postgres'); this.intent = path.join(this.root, 'restore-intent.json')
  }
  private folder(id: string) { if (!validId.test(id)) throw new OfficialError('备份编号无效'); return path.join(this.backups, id) }
  async list() {
    if (!await exists(this.backups)) return []
    await directory(this.backups)
    const result = []
    for (const id of (await fs.readdir(this.backups)).filter(id => validId.test(id)).sort().reverse()) {
      try { const manifest = await this.manifest(id); result.push({ id, createdAt: manifest.createdAt, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }) }
      catch { result.push({ id, createdAt: null, bytes: null, invalid: true }) }
    }
    return result
  }
  private async manifest(id: string): Promise<Manifest> {
    await directory(this.root); await directory(this.backups)
    const folder = this.folder(id); await directory(folder)
    const file = path.join(folder, 'manifest.json'), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24 * 1024 ** 2) throw new OfficialError('备份清单无效', 409)
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Manifest
    if (value.version !== 1 || value.product !== 'rvb-official-postgres' || !Array.isArray(value.files) || !value.files.length || value.files.length > 100000) throw new OfficialError('备份版本不兼容', 409)
    return value
  }
  async verify(id: string) {
    const manifest = await this.manifest(id), files = await inventory(path.join(this.folder(id), 'postgres'))
    if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new OfficialError('备份校验失败：文件有缺失或已改变', 409)
    return manifest
  }
  async create() {
    await directory(this.root)
    // Caller has already drained Colyseus and stopped PostgreSQL.
    const files = await inventory(this.data), id = Date.now() + '-' + randomUUID()
    await fs.mkdir(this.backups, { recursive: true }); await directory(this.backups)
    const staging = path.join(this.backups, id + '.partial'), target = this.folder(id)
    await fs.mkdir(staging)
    await fs.cp(this.data, path.join(staging, 'postgres'), { recursive: true, errorOnExist: true, force: false })
    if (JSON.stringify(await inventory(path.join(staging, 'postgres'))) !== JSON.stringify(files)) throw new OfficialError('备份复制校验失败', 409)
    const manifest: Manifest = { version: 1, product: 'rvb-official-postgres', createdAt: new Date().toISOString(), files }
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' })
    await fs.rename(staging, target)
    return id
  }
  /** Restore is staged and reversible. Keep the old cluster until the new one boots. */
  async stageRestore(id: string) {
    const manifest = await this.verify(id)
    await inventory(this.data)
    const suffix = Date.now() + '-' + randomUUID(), staged = 'postgres.restore-' + suffix, previous = 'postgres.previous-' + suffix
    await fs.cp(path.join(this.folder(id), 'postgres'), path.join(this.root, staged), { recursive: true, errorOnExist: true, force: false })
    if (JSON.stringify(await inventory(path.join(this.root, staged))) !== JSON.stringify(manifest.files)) throw new OfficialError('恢复副本校验失败', 409)
    // The marker is written before moving the current data, so a crash cannot create a fresh empty database.
    const marker = await fs.open(this.intent, 'wx')
    try { await marker.writeFile(JSON.stringify({ version: 1, staged, previous })); await marker.sync() } finally { await marker.close() }
    await fs.rename(this.data, path.join(this.root, previous))
    await fs.rename(path.join(this.root, staged), this.data)
  }
  async commitRestore() { await fs.unlink(this.intent) }
  async recoverInterruptedRestore() {
    if (!await exists(this.intent)) return false
    const value = JSON.parse(await fs.readFile(this.intent, 'utf8')) as { version: number; previous: string; staged: string }
    if (value.version !== 1 || !/^postgres\.previous-[0-9]{13}-[a-f0-9-]{36}$/.test(value.previous) || !/^postgres\.restore-[0-9]{13}-[a-f0-9-]{36}$/.test(value.staged)) throw new OfficialError('恢复记录损坏，请保留数据并联系维护者', 503)
    const previous = path.join(this.root, value.previous)
    if (await exists(previous)) {
      await inventory(previous)
      if (await exists(this.data)) {
        await directory(this.data)
        const pidFile = path.join(this.data, 'data/postmaster.pid')
        if (await exists(pidFile)) {
          const stat = await fs.lstat(pidFile)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new OfficialError('恢复副本的进程记录无效', 503)
          const pid = Number((await fs.readFile(pidFile, 'utf8')).split(/\r?\n/)[0])
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new OfficialError('恢复副本的进程编号无效', 503)
          let running = true
          try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false; else throw error }
          if (running) throw new OfficialError('恢复副本的数据库进程仍在运行，不能替换数据', 503)
        }
        // A crashed replacement can contain a stale PID or corrupt files. Preserve it;
        // only the known-good previous cluster must pass full backup validation.
        await fs.rename(this.data, path.join(this.root, 'postgres.failed-' + Date.now() + '-' + randomUUID()))
      }
      await fs.rename(previous, this.data)
    } else await inventory(this.data)
    await fs.unlink(this.intent)
    return true
  }
}
