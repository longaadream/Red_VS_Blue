;(function () {
  'use strict'
  const PORTS = [2567, 38621]
  const TIMEOUT_MS = 2000
  const DEFAULT_SUBNETS = ['192.168.1', '192.168.0', '192.168.2', '10.0.0']
  const validIp = ip => typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255)

  function startLanScan(options) {
    const { onFound, onProgress, onDone, onError, full = false } = options || {}
    const native = window.RvBHost || window.electronAPI
    let cancelled = false
    const scanId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    let stopUdp = () => {}
    const controller = { cancel() { cancelled = true; stopUdp() } }
    async function run() {
      let addresses = [], own = {}
      // Resolve local identity before registering UDP or launching HTTP probes.
      if (native?.getLanIps) {
        try { addresses = await native.getLanIps() } catch (error) { onError?.(error) }
      } else if (window.RvBBridge?.getLocalIp) {
        addresses = [window.RvBBridge.getLocalIp()]
      }
      if (native?.getHostInfo) {
        try { own = await native.getHostInfo() || {} } catch (error) { onError?.(error) }
      }
      if (cancelled) return
      addresses = (Array.isArray(addresses) ? addresses : []).filter(validIp)
      const ownIps = new Set([...addresses, ...(own.ips || []), ...(own.localIps || [])])
      const isSelf = info => /^(127\.|0\.)/.test(info.ip) || ownIps.has(info.ip) || (own.serverId && info.serverId === own.serverId)
      const found = []
      function accept(info) {
        if (cancelled || !info || !validIp(info.ip) || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || isSelf(info)) return
        const result = { url: 'http://' + info.ip + ':' + info.port, ip: info.ip, port: info.port }
        const name = info.serverName || info.name
        if (typeof name === 'string') result.name = name.slice(0, 128)
        if (typeof info.serverId === 'string' && /^[\w-]{1,64}$/.test(info.serverId)) result.serverId = info.serverId
        if (found.some(server => server.url === result.url || (result.serverId && server.serverId === result.serverId))) return
        found.push(result)
        onFound?.(result)
      }
      if (native?.startDiscoverHosts && native.onUdpHostFound) {
        native.offUdpDiscovery?.()
        native.onUdpHostFound(info => { if (info?.discoveryScanId === scanId) accept(info) })
        stopUdp = () => {
          native.offUdpDiscovery?.()
          if (native.stopDiscoverHosts) Promise.resolve(native.stopDiscoverHosts(scanId)).catch(error => onError?.(error))
        }
        try { Promise.resolve(native.startDiscoverHosts(3000, scanId)).catch(error => { if (!cancelled) onError?.(error) }) }
        catch (error) { onError?.(error) }
      }
      const usable = addresses.filter(ip => !/^(127\.|169\.254\.)/.test(ip))
      const subnets = usable.length ? [...new Set(usable.map(ip => ip.split('.').slice(0, 3).join('.')))] : DEFAULT_SUBNETS
      const ports = full ? [...PORTS, ...Array.from({ length: 9 }, (_, i) => 38622 + i)] : PORTS
      const tasks = []
      // Virtual LAN peers need not share our /24. Probe the last successful
      // direct connection first, without scanning millions of VPN addresses.
      try {
        const saved = window.localStorage?.getItem('rvb_lan_server_url')
          || (native?.getRemoteUrl ? await native.getRemoteUrl() : null)
          || window.localStorage?.getItem('rvb_remote_server_url')
        if (saved) {
          const peer = new URL(saved)
          const port = Number(peer.port || (peer.protocol === 'https:' ? 443 : 80))
          if (peer.protocol === 'http:' && validIp(peer.hostname) && !isSelf({ ip: peer.hostname })) tasks.push({ ip: peer.hostname, port })
        }
      } catch (error) { onError?.(error) }
      for (const subnet of subnets) for (let octet = 1; octet <= 254; octet++) {
        const ip = subnet + '.' + octet
        if (!isSelf({ ip })) for (const port of ports) tasks.push({ ip, port })
      }
      for (let i = 0; i < tasks.length && !cancelled; i += 64) {
        await Promise.all(tasks.slice(i, i + 64).map(async ({ ip, port }) => {
          const url = 'http://' + ip + ':' + port
          try {
            const health = await RvBColyseus.requestAt(url, 'system.health', {}, TIMEOUT_MS)
            if (health?.ok === true && health.protocol === 'rvb-colyseus') accept({ ...health, ip, port })
          } catch { /* Unreachable addresses are expected while scanning the subnet. */ }
        }))
        if (cancelled) return
        onProgress?.(Math.min(i + 64, tasks.length), tasks.length)
      }
      if (!cancelled) onDone?.(found)
    }
    run().catch(error => { if (!cancelled) { stopUdp(); onError?.(error); onDone?.([]) } })
    return controller
  }
  window.RvBLanDiscover = { startLanScan }
})()
