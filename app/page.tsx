import os from 'os'

function getLanIps(): string[] {
  const ips: string[] = []
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
      }
    }
  } catch {}
  return ips
}

export default function Home() {
  const ips = getLanIps()
  const port = process.env.PORT ?? 3000

  return (
    <div style={{ padding: '24px 20px', background: '#0f172a', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', color: '#e2e8f0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 900, color: '#ef4444', letterSpacing: 1 }}>RED</span>
        <span style={{ fontSize: 14, color: '#64748b' }}>vs</span>
        <span style={{ fontSize: 22, fontWeight: 900, color: '#3b82f6', letterSpacing: 1 }}>BLUE</span>
        <span style={{ fontSize: 13, color: '#22c55e', marginLeft: 8 }}>● 服务器运行中</span>
      </div>
      <p style={{ fontSize: 13, color: '#475569', marginBottom: 24 }}>Game Server — API endpoints at /api/*</p>

      {ips.length > 0 && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '16px 20px', marginBottom: 16, maxWidth: 480 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12 }}>
            局域网地址（分享给同网络的玩家）
          </div>
          {ips.map(ip => (
            <div key={ip} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <code style={{
                background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
                padding: '8px 14px', fontSize: 18, fontWeight: 700, color: '#e2e8f0',
                letterSpacing: 1, flex: 1,
              }}>
                http://{ip}:{port}
              </code>
            </div>
          ))}
          <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
            客户端点击"搜索局域网"即可自动发现，或手动输入上方地址
          </div>
        </div>
      )}

      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: '12px 16px', maxWidth: 480 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>API 端点</div>
        {['/api/ping', '/api/lobby', '/api/rooms', '/api/pieces', '/api/maps', '/api/skills'].map(ep => (
          <div key={ep} style={{ fontSize: 13, color: '#94a3b8', padding: '2px 0' }}>{ep}</div>
        ))}
      </div>
    </div>
  )
}
