;(function () {
  'use strict'

  // ── 配置 ──────────────────────────────────────────────────────────────────────
  const PORTS = [3000, 3001, 7878]
  const TIMEOUT_MS = 900

  // 快速扫描：路由器附近(.1-.15)和 DHCP 常见范围(.100-.130)
  const QUICK_LAST_OCTETS = [
    ...Array.from({ length: 15 }, (_, i) => i + 1),    // 1-15
    ...Array.from({ length: 31 }, (_, i) => i + 100),  // 100-130
  ]

  // 全量扫描（快速未找到时由用户触发）
  const FULL_LAST_OCTETS = Array.from({ length: 254 }, (_, i) => i + 1)

  // 不依赖 Electron bridge 时扫描的默认子网
  const DEFAULT_SUBNETS = ['192.168.1', '192.168.0', '192.168.2', '10.0.0']

  function validPort(value) {
    const port = Number(value)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  }

  function resolveWsPort(server) {
    const explicit = validPort(server && server.wsPort)
    if (explicit) return explicit
    const httpPort = validPort(server && server.port)
    return httpPort === 3000 ? 3001 : (httpPort || 3001)
  }

  async function fetchJson(url) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // ── 单 IP 探测 ─────────────────────────────────────────────────────────────────
  async function probeOne(ip, port) {
    const url = 'http://' + ip + ':' + port
    const ping = await fetchJson(url + '/api/ping')
    if (!ping || ping.name !== 'RED vs BLUE Server') return null

    const wsInfo = await fetchJson(url + '/api/ws-info')
    const server = { url, ip, port, wsPort: wsInfo && wsInfo.wsPort }
    return { url, ip, port, wsPort: resolveWsPort(server) }
  }

  // ── 批量并发扫描 ───────────────────────────────────────────────────────────────
  async function scanBatch(tasks, onFound, isCancelled) {
    const found = []
    const CONCURRENCY = 25

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      if (isCancelled()) break
      const batch = tasks.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(({ ip, port }) => probeOne(ip, port)))
      for (const r of results) {
        if (r && !found.some(f => f.url === r.url)) {
          found.push(r)
          onFound && onFound(r)
        }
      }
    }
    return found
  }

  // ── 构建任务列表 ───────────────────────────────────────────────────────────────
  function buildTasks(subnets, lastOctets) {
    const tasks = []
    for (const subnet of subnets) {
      for (const octet of lastOctets) {
        for (const port of PORTS) {
          tasks.push({ ip: subnet + '.' + octet, port })
        }
      }
    }
    return tasks
  }

  // ── 主入口 ─────────────────────────────────────────────────────────────────────
  /**
   * startLanScan(options)
   *   options.onFound(server)    — 发现服务器时回调，server = { url, ip, port }
   *   options.onProgress(n, total) — 进度回调
   *   options.onDone(found)      — 扫描完成
   *   options.full               — true = 全量扫描，false = 快速扫描（默认）
   * 同步返回 { cancel() } 控制器，扫描在后台异步运行
   */
  function startLanScan(options) {
    const { onFound, onProgress, onDone, full = false } = options || {}
    let cancelled = false
    const controller = { cancel() { cancelled = true } }

    async function run() {
      // 1. 确定子网
      let subnets = DEFAULT_SUBNETS
      if (window.electronAPI && typeof window.electronAPI.getLanIps === 'function') {
        try {
          const ips = await window.electronAPI.getLanIps()
          if (Array.isArray(ips) && ips.length) {
            subnets = [...new Set(ips.map(ip => ip.split('.').slice(0, 3).join('.')))]
          }
        } catch {}
      } else if (window.RvBBridge && typeof window.RvBBridge.getLocalIp === 'function') {
        try {
          const ip = window.RvBBridge.getLocalIp()
          if (ip && ip.includes('.')) {
            subnets = [ip.split('.').slice(0, 3).join('.')]
          }
        } catch {}
      }

      // 2. 构建任务
      const octets = full ? FULL_LAST_OCTETS : QUICK_LAST_OCTETS
      const tasks = buildTasks(subnets, octets)
      const total = tasks.length

      // 3. 分批并发，汇报进度
      const found = []
      const CONCURRENCY = 25

      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        if (cancelled) break
        const batch = tasks.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map(({ ip, port }) => probeOne(ip, port)))
        for (const r of results) {
          if (r && !found.some(f => f.url === r.url)) {
            found.push(r)
            onFound && onFound(r)
          }
        }
        onProgress && onProgress(Math.min(i + CONCURRENCY, total), total)
      }

      if (!cancelled) onDone && onDone(found)
    }

    run()
    return controller
  }

  // ── 导出到全局 ────────────────────────────────────────────────────────────────
  window.RvBLanDiscover = { startLanScan, resolveWsPort }
})()
