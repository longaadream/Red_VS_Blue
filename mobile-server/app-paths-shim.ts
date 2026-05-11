// Shim for @/lib/app-paths — used in the mobile server esbuild bundle.
// getDataRoot() returns 'data' so that path.join('data', 'skills', 'x.json')
// produces a path our fs-shim recognises.

export function getDataRoot(): string { return 'data' }
export function getAppRoot(): string { return '.' }
export function getUserDataDir(): string { return '.' }
