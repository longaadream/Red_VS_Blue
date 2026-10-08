import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep build and tracing paths inside this checkout so standalone output is flat.
  turbopack: {
    root: path.resolve(__dirname),
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
  // Must match turbopack.root — Next.js enforces equality.
  outputFileTracingRoot: path.resolve(__dirname),
  serverExternalPackages: ['adm-zip', 'ws'],
}

export default nextConfig
