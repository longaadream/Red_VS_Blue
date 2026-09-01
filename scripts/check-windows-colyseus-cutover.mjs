import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

const forbiddenPaths = [
  'instrumentation.ts',
  'electron',
  'electron-builder.server.json',
  'lib/db.ts',
  'lib/ws-server.ts',
  'lib/game/room-store.ts',
  'lib/server/battle-authority-async-journal.ts',
  'lib/server/battle-authority-persistence.ts',
  'lib/server/battle-authority-shutdown.ts',
  'lib/server/battle-command.ts',
  'prisma',
  'data/pages/js/ws-client.js',
  'scripts/init-db.js',
  'scripts/ws-same-port-server.cjs',
  'app/api/rooms',
  'app/api/lobby',
  'app/api/battle',
  'app/api/records',
  'app/api/ws-info',
]

for (const relativePath of forbiddenPaths) {
  const target = path.join(root, relativePath)
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || walk(target).length > 0)) {
    failures.push(`forbidden path exists: ${relativePath}`)
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
for (const dependency of ['@prisma/client', 'prisma', 'ws', '@types/ws']) {
  if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
    failures.push(`forbidden direct dependency: ${dependency}`)
  }
}

const sourceRoots = ['app', 'lib', 'electron-client', 'electron-editor', 'data/pages']
const forbiddenSource = [
  { pattern: /from\s+['"]ws['"]|require\(['"]ws['"]\)|new\s+WebSocket\s*\(|WebSocketServer/g, label: 'raw websocket implementation' },
  { pattern: /@prisma\/client|PrismaClient|schema\.prisma/g, label: 'Prisma runtime' },
  { pattern: /RVB_BATTLE_AUTHORITY_V2|RVB_BATTLE_ASYNC_JOURNAL|DISABLE_WS|RVB_PROFILE_EXPECT_WEBSOCKET/g, label: 'legacy authority toggle' },
  { pattern: /DATABASE_URL\s*:\s*`?file:|PRAGMA\s|busy_timeout|journal_mode\s*=\s*wal/gi, label: 'SQLite runtime' },
  { pattern: /(?:from|import\()\s*['"][^'"]*room-store['"]/g, label: 'legacy RoomStore import' },
  { pattern: /\bRvBWs\b/g, label: 'legacy player adapter alias' },
]

for (const relativeRoot of sourceRoots) {
  for (const file of walk(path.join(root, relativeRoot))) {
    if (file.endsWith('.min.js') || file.endsWith(path.join('data', 'pages', 'js', 'colyseus-sdk.js'))) continue
    if (!/\.(?:[cm]?[jt]sx?|html)$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const check of forbiddenSource) {
      check.pattern.lastIndex = 0
      if (check.pattern.test(source)) {
        failures.push(`${check.label}: ${path.relative(root, file).replaceAll('\\', '/')}`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`[windows-cutover] failed:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('[windows-cutover] OK: Windows player runtime is Colyseus + PostgreSQL only')
}

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}
