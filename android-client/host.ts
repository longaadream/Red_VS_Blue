import { Capacitor, registerPlugin } from '@capacitor/core'
interface HostStatus { running: boolean; state: string; ips?: string[]; profileIdentity?: Record<string, unknown> }
interface NativeHost {
  info(): Promise<HostStatus>
  start(): Promise<HostStatus & { ok: boolean; localUrl?: string }>
  stop(): Promise<{ ok: boolean }>
  relay(options: unknown): Promise<Record<string, unknown>>
}
if (Capacitor.isNativePlatform()) {
  const native = registerPlugin<NativeHost>('AndroidHost')
  const api = {
    getHostInfo: () => native.info(),
    getLanIps: async () => (await native.info()).ips || [],
    ensureLocalAuthority: () => native.start().catch((error: Error) => ({ ok: false, error: error.message })),
    getMode: async () => {
      const status = await native.info()
      const response = await fetch('__tutorial-profile.json', { cache: 'no-store' })
      if (!response.ok) throw Error('本地资源不可用')
      const identity = await response.json()
      return { mode: 'local', ready: status.running, running: status.running, state: status.state, localUrl: 'http://127.0.0.1:2567', serverUrl: 'http://127.0.0.1:2567', profileIdentity: identity, localAuthorityProfileIdentity: status.profileIdentity || identity }
    },
    relayControl: (options: unknown) => native.relay(options),
    stopLocalAuthority: () => native.stop(),
  }
  ;(window as Window & { RvBHost?: typeof api }).RvBHost = api
}
