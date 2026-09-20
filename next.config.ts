import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Widen filesystem root to cover the node_modules junction target (points to ../red181/node_modules in worktree)
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  // Resource-pack imports are streamed through the local Next server. Keep
  // its proxy limit aligned with PROFILE_ARCHIVE_LIMITS_V1 (32 MiB), otherwise
  // larger valid .rvbpack files are truncated before ADM-ZIP can read them.
  experimental: {
    proxyClientMaxBodySize: '32mb',
    ...(process.env.RVB_BUILD_LOW_MEMORY === '1' ? {
      cpus: 1,
      webpackMemoryOptimizations: true,
    } : {}),
  },
  // Must match turbopack.root — Next.js enforces equality. stage-client-resources.js handles nested standalone output.
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  // Exclude staging/build output dirs so their stale files don't appear in .nft.json traces.
  outputFileTracingExcludes: {
    '**': ['release-018-build/_client-stage/**', 'release-018-build/_client-node/**', 'release-018-build/_client-colyseus/**'],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ['adm-zip', 'ws'],
}

export default nextConfig
