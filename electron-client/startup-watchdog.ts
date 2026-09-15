export const STARTUP_PROGRESS_TYPE = 'rvb:authority:startup-progress'
const stages: Record<string, string> = {
  database: '正在准备对局数据库', adventure: '正在准备冒险存档',
  profile: '正在校验资源', signature: '正在校验资源签名', ready: '资源校验完成，正在监听',
}

/** Only completed work advances the idle deadline; repeated status is not a heartbeat. */
export class StartupWatchdog {
  private lastProgress: number
  private work = -1
  message = '正在加载对局服务'
  constructor(private readonly started: number, private readonly idleMs = 90_000, private readonly totalMs = 900_000) {
    this.lastProgress = started
  }
  observe(value: unknown, now: number): boolean {
    if (!value || typeof value !== 'object') return false
    const p = value as Record<string, unknown>
    if (p.type !== STARTUP_PROGRESS_TYPE || typeof p.stage !== 'string' || !Object.prototype.hasOwnProperty.call(stages, p.stage)
      || !Number.isSafeInteger(p.work) || (p.work as number) <= this.work) return false
    this.work = p.work as number
    this.lastProgress = now
    this.message = stages[p.stage]
    if (Number.isSafeInteger(p.completed) && Number.isSafeInteger(p.total)
      && (p.total as number) > 0 && (p.completed as number) >= 0 && (p.completed as number) <= (p.total as number)) {
      this.message += `（${p.completed}/${p.total} 个文件）`
    }
    return true
  }
  failure(now: number): string | null {
    if (now - this.started >= this.totalMs) return `准备游戏超过总时限：${this.message}`
    if (now - this.lastProgress >= this.idleMs) return `准备游戏长时间无进展：${this.message}`
    return null
  }
}
