import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  output: 'standalone',
  // 钉死 trace root 为项目根，避免 Next.js 把上一级目录认成 monorepo 根
  // 导致 .next/standalone/v0-game-menu-design/... 这种嵌套（参考 package.json
  // build 末尾的 cp '.next/static' '.next/standalone/.next/static'：那段假设无嵌套）
  outputFileTracingRoot: path.resolve(__dirname),
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ['adm-zip', 'ws'],
}

export default nextConfig
