import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function acquireOfficialProcessLock(root: string): () => void {
  const lock = path.join(root, 'official.lock'), gate = path.join(root, 'official-start.lock'), owner = randomUUID()
  // All creators and stale-lock recovery share this gate. A crash in this short
  // section fails closed and requires the operator to inspect the stale gate.
  try { fs.writeFileSync(gate, String(process.pid), { flag: 'wx' }) }
  catch { throw new Error('另一个启动正在进行；若已异常退出，请确认服务全已停止后检查 official-start.lock') }
  try {
    if (fs.existsSync(lock)) {
      const previous = JSON.parse(fs.readFileSync(lock, 'utf8'))
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('运行锁损坏，请确认服务已停止后检查数据目录')
      try { process.kill(previous.pid, 0); throw new Error('官方服务器或配置窗口已经运行，请勿重复启动') }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
      fs.unlinkSync(lock)
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx' })
  } finally { fs.unlinkSync(gate) }
  return () => {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).owner === owner) fs.unlinkSync(lock) }
    catch { /* A missing lock has no ownership to release. */ }
  }
}
