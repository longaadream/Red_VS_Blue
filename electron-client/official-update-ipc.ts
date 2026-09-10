const READ_ONLY = new Set(['pack-list', 'get-mode', 'get-host-info', 'get-lan-ips', 'get-resource-pack-status'])

export function assertOfficialUpdateIpcAllowed(channel: string, applying: boolean): void {
  if (applying && !channel.startsWith('official-update-') && !READ_ONLY.has(channel)) throw new Error('正在应用官方更新，请稍候')
}
