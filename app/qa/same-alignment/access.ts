const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isRed43LocalDevelopmentHostname(hostname: string): boolean {
  return process.env.NODE_ENV !== 'production' && LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

export function isRed43LocalDevelopmentHostHeader(host: string | null): boolean {
  if (!host || process.env.NODE_ENV === 'production') return false

  try {
    return isRed43LocalDevelopmentHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}
