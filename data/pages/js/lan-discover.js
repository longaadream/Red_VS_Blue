;(function () {
  'use strict'

  // LAN discovery probes public HTTP origins only. The WebSocket endpoint is
  // always available on the exact same origin through /ws/rooms/{roomId}.
  const PORTS = [3000, 7878]
  const TIMEOUT_MS = 900

  const QUICK_LAST_OCTETS = [
    ...Array.from({ length: 15 }, (_, i) => i + 1),
    ...Array.from({ length: 31 }, (_, i) => i + 100),
  ]
  const FULL_LAST_OCTETS = Array.from({ length: 254 }, (_, i) => i + 1)
  const DEFAULT_SUBNETS = ['192.168.1', '192.168.0', '192.168.2', '10.0.0']

  // Discovery probes the same-origin WebSocket RPC directly.

  async function probeOne(ip, port) {
    const url = 'http://' + ip + ':' + port
    try {
      const health = await RvBWs.requestAt(url, 'system.health', {}, TIMEOUT_MS)
      if (!health || health.protocol !== 'rvb-ws') return null
      return { url, ip, port }
    } catch {
      return null
    }
  }

  function buildTasks(subnets, lastOctets) {
    const tasks = []
    for (const subnet of subnets) {
      for (const octet of lastOctets) {
        for (const port of PORTS) tasks.push({ ip: subnet + '.' + octet, port })
      }
    }
    return tasks
  }

  function startLanScan(options) {
    const { onFound, onProgress, onDone, full = false } = options || {}
    let cancelled = false
    const controller = { cancel() { cancelled = true } }

    async function run() {
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
          if (ip && ip.includes('.')) subnets = [ip.split('.').slice(0, 3).join('.')]
        } catch {}
      }

      const octets = full ? FULL_LAST_OCTETS : QUICK_LAST_OCTETS
      const tasks = buildTasks(subnets, octets)
      const total = tasks.length
      const found = []
      const CONCURRENCY = 25

      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        if (cancelled) break
        const batch = tasks.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map(({ ip, port }) => probeOne(ip, port)))
        for (const result of results) {
          if (result && !found.some(server => server.url === result.url)) {
            found.push(result)
            onFound && onFound(result)
          }
        }
        onProgress && onProgress(Math.min(i + CONCURRENCY, total), total)
      }

      if (!cancelled) onDone && onDone(found)
    }

    run()
    return controller
  }

  window.RvBLanDiscover = { startLanScan }
})()
