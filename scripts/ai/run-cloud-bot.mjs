import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(resolve(root, 'package.json'))
const SHUTDOWN_GRACE_MS = 3_000
const FINAL_EXIT_GRACE_MS = 1_000

function usage() {
  console.log(`Usage: npm run ai:cloud-bot -- <mode> <config.json> [options]

Modes:
  --help                         Show this help without reading a config or using a network
  --check-config <path>          Validate config syntax and bounds without network access
  --run <path>                   Run the bounded cloud bot process

Run options:
  --max-runtime-ms <n>           Override the config runtime limit
  --max-actions <n>              Override the config action limit
`)
}

function parsePositive(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function parseArgs(argv) {
  const result = { mode: undefined, configPath: undefined, maxRuntimeMs: undefined, maxActions: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') result.help = true
    else if (flag === '--check-config' || flag === '--run') {
      if (result.mode) throw new Error('Choose exactly one of --check-config or --run')
      result.mode = flag.slice(2)
      result.configPath = argv[++index]
      if (!result.configPath) throw new Error(`${flag} requires a JSON config path`)
    } else if (flag === '--max-runtime-ms' || flag === '--max-actions') {
      const value = argv[++index]
      if (!value) throw new Error(`${flag} requires a value`)
      if (flag === '--max-runtime-ms') result.maxRuntimeMs = parsePositive(value, flag)
      else result.maxActions = parsePositive(value, flag)
    } else throw new Error(`Unknown argument ${flag}`)
  }
  if (result.help) return result
  if (!result.mode) throw new Error('Choose --check-config or --run')
  if (result.mode === 'check-config' && (result.maxRuntimeMs !== undefined || result.maxActions !== undefined)) {
    throw new Error('Run limit overrides require --run')
  }
  return result
}

function readConfig(path) {
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')) } catch {
    throw new Error(`Unable to read JSON config ${path}`)
  }
}

async function buildRuntime() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-cloud-bot-'))
  const outfile = join(temporaryDirectory, 'runtime.cjs')
  const source = `
    import { createCloudBotGoalOptions, executeCloudBot, parseCloudBotConfig, publicRunResult } from ${JSON.stringify(resolve(root, 'lib/ai-bot/cloud-bot-cli.ts'))}
    import { decideGoalAction } from ${JSON.stringify(resolve(root, 'lib/ai-bot/goal-policy.ts'))}

    export function check(value) {
      const config = parseCloudBotConfig(value)
      return {
        valid: true,
        mode: config.mode ?? 'direct',
        serverUrl: config.serverUrl,
        roomId: config.roomId,
        hasCreate: Boolean(config.create),
        alignment: config.alignment,
        pieceCount: config.pieces.length,
      }
    }

    export async function run(value, overrides, signal) {
      const config = parseCloudBotConfig({
        ...value,
        ...(overrides.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: overrides.maxRuntimeMs }),
        ...(overrides.maxActions === undefined ? {} : { maxActions: overrides.maxActions }),
      })
      const result = await executeCloudBot(config, {
        signal,
        decide: (state, playerId, context) => {
          const goal = config.goal && typeof config.goal === 'object' ? config.goal : undefined
          return decideGoalAction(state, playerId, createCloudBotGoalOptions(goal, context.budgetMs))
        },
      })
      return publicRunResult(result)
    }
  `
  await build({
    absWorkingDir: root,
    tsconfig: resolve(root, 'tsconfig.json'),
    stdin: { contents: source, loader: 'ts', resolveDir: root, sourcefile: 'cloud-bot-runtime.ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent',
  })
  const previousLog = console.log
  const previousWarn = console.warn
  const previousError = console.error
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return { runtime: require(outfile), cleanup: () => rmSync(temporaryDirectory, { recursive: true, force: true }) }
  } finally {
    console.log = previousLog
    console.warn = previousWarn
    console.error = previousError
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  const input = readConfig(args.configPath)
  const controller = new AbortController()
  let runtimeTimer
  let exitTimer
  let cleanup
  const forceExit = (message) => {
    controller.abort()
    process.stderr.write(`[ai:cloud-bot] ${message}\n`, () => process.exit(1))
    // A blocked output stream must not retain a stalled SDK connection forever.
    setTimeout(() => process.exit(1), FINAL_EXIT_GRACE_MS)
  }
  const onSignal = () => {
    controller.abort()
    clearTimeout(exitTimer)
    exitTimer = setTimeout(() => forceExit('Shutdown deadline exceeded'), SHUTDOWN_GRACE_MS)
  }
  if (args.mode === 'run') {
    const runtimeLimit = args.maxRuntimeMs ?? parsePositive(input.maxRuntimeMs ?? 15 * 60_000, 'maxRuntimeMs')
    // This CLI owns its process. The SDK cannot cancel every HTTP request or
    // WebSocket close handshake, so keep a final process deadline as well as
    // the library's cooperative action/receipt deadlines.
    runtimeTimer = setTimeout(() => controller.abort(), runtimeLimit)
    exitTimer = setTimeout(() => forceExit('Process runtime and shutdown deadline exceeded'), runtimeLimit + SHUTDOWN_GRACE_MS)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }
  try {
    const built = await buildRuntime()
    cleanup = built.cleanup
    const runtime = built.runtime
    if (args.mode === 'check-config') {
      process.stdout.write(`${JSON.stringify(runtime.check(input), null, 2)}\n`)
      return
    }
    const result = await runtime.run(input, {
      maxRuntimeMs: args.maxRuntimeMs,
      maxActions: args.maxActions,
    }, controller.signal)
    await new Promise((resolveWrite, rejectWrite) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, error => error ? rejectWrite(error) : resolveWrite())
    })
  } finally {
    clearTimeout(runtimeTimer)
    clearTimeout(exitTimer)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (args.mode === 'run') {
      // Normal runs exit naturally. If an abandoned SDK socket is still alive,
      // end only this standalone CLI after allowing result/error output to flush.
      setTimeout(() => process.exit(process.exitCode || 0), FINAL_EXIT_GRACE_MS).unref()
    }
    cleanup?.()
  }
}

main().catch(error => {
  process.stderr.write(`[ai:cloud-bot] ${error?.message || 'cloud bot failed'}\n`)
  process.exitCode = 1
})
