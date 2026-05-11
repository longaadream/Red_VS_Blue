// 房间自动清理配置（运行时可调整）
// 默认 24 小时，管理员可通过 /api/admin/rooms 接口修改

let cleanupThresholdHours = 24   // 自动清理阈值（小时）
let cleanupStatuses: string[] = ['finished']  // 清理哪些状态的房间

export function getCleanupConfig() {
  return {
    thresholdHours: cleanupThresholdHours,
    statuses: cleanupStatuses,
  }
}

export function setCleanupThresholdHours(hours: number) {
  cleanupThresholdHours = Math.max(0.5, hours)  // 最小 30 分钟
}

export function setCleanupStatuses(statuses: string[]) {
  cleanupStatuses = statuses
}

export function getCleanupCutoff(): Date {
  return new Date(Date.now() - cleanupThresholdHours * 60 * 60 * 1000)
}
