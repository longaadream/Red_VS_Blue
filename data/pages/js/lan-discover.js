;(function () {
  'use strict'

  // Both platforms expose the same Colyseus origin; Windows may choose a
  // neighbouring free port when more than one client runs on the machine.
  const PORTS = [2567, 38621]
  const TIMEOUT_MS = 900

  const FULL_LAST_OCTETS = Array.from({ length: 254 }, (_, i) => i + 1)
  const DEFAULT_SUBNETS = ['192.168.1', '192.168.0', '192.168.2', '10.0.0']

  // Discovery probes the Colyseus HTTP health endpoint on the public origin.

  async function probeOne(ip, port) {
    const url = 'http://' + ip + ':' + port
    try {
      const health = await RvBColyseus.requestAt(url, 'system.health', {}, TIMEOUT_MS)
      if (!health || health.ok !== true || health.protocol !== 'rvb-colyseus') return null
      return { url, ip, port }
    } catch {
      return null
    }
  }

  function buildTasks(subnets, lastOctets, ports) {
    const tasks = []
    for (const subnet of subnets) {
      for (const octet of lastOctets) {
        for (const port of ports) tasks.push({ ip: subnet + '.' + octet, port })
      }
    }
    return tasks
  }

  function startLanScan(options) {
    const { onFound, onProgress, onDone, onError, full = false } = options || {}
    let cancelled = false
    const controller = { cancel() { cancelled = true } }

    async function run() {
      let subnets = DEFAULT_SUBNETS
      const native = window.RvBHost || window.electronAPI
      if (native && typeof native.getLanIps === 'function') {
        try {
          const addresses = await native.getLanIps()
          if (cancelled) return
          const ips = (Array.isArray(addresses) ? addresses : []).filter(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255) && !/^(127\.|169\.254\.)/.test(ip))
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

      // Hotspot gateways and DHCP clients can use any host octet, not just .1
      // or .100. Quick search covers every address on the detected /24s.
      const ports = full ? [...PORTS, ...Array.from({ length: 9 }, (_, i) => 38622 + i)] : PORTS
      const tasks = buildTasks(subnets, FULL_LAST_OCTETS, ports)
      const total = tasks.length
      const found = []
      const CONCURRENCY = 64

      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        if (cancelled) break
        const batch = tasks.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map(({ ip, port }) => probeOne(ip, port)))
        if (cancelled) return
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

    run().catch(error => { if (!cancelled) { if (onError) onError(error); if (onDone) onDone([]) } })
    return controller
  }

  window.RvBLanDiscover = { startLanScan }
})()
