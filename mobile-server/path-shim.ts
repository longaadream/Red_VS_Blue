// Shim for the 'path' Node.js module — browser-safe implementation.
// Only the subset used by lib/game/* is implemented.

export function join(...parts: string[]): string {
  return parts
    .filter(p => p != null && p !== '')
    .join('/')
    .replace(/\/+/g, '/')
}

export function resolve(...parts: string[]): string {
  return join(...parts)
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.substring(0, idx) || '.' : '.'
}

export function basename(p: string, ext?: string): string {
  const b = p.split('/').pop() || ''
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i) : ''
}

export function relative(from: string, to: string): string {
  return to
}

export default { join, resolve, dirname, basename, extname, relative }
