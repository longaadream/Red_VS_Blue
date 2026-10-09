import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)

function usage() {
  console.log(`Usage: npm run ai:goal-search -- [options]

Offline options:
  --smoke                 Run the real five-card demon summon fixture
  --input <path>          Read a complete offline BattleState JSON file
  --player <id>           Player to search for (default: player-red)
  --seed <uint32>         Root seed for deterministic isolated simulation
  --goal <template-id>    Goal: a living piece template owned by --player
  --max-nodes <n>         Search/transition node bound (default: 256)
  --max-depth <n>         Route depth bound (default: 8)
  --max-time-ms <n>       Wall-clock bound (default: 2000)
  --help                  Show this help
`)
}

function parseUint32(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`${name} must be a uint32 integer`)
  }
  return parsed
}

function parseBound(value, name, minimum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return parsed
}

function parseArgs(argv) {
  const result = {
    player: 'player-red',
    goal: 'kiljaedan',
    maxNodes: 256,
    maxDepth: 8,
    maxTimeMs: 2_000,
  }
  const takesValue = new Map([
    ['--input', 'input'], ['--player', 'player'], ['--seed', 'seed'], ['--goal', 'goal'],
    ['--max-nodes', 'maxNodes'], ['--max-depth', 'maxDepth'], ['--max-time-ms', 'maxTimeMs'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') result.help = true
    else if (flag === '--smoke') result.smoke = true
    else if (takesValue.has(flag)) {
      const value = argv[++index]
      if (!value) throw new Error(`${flag} requires a value`)
      result[takesValue.get(flag)] = value
    } else throw new Error(`Unknown argument ${flag}`)
  }
  if (result.help) return result
  if (result.smoke && result.input) throw new Error('--smoke and --input cannot be used together')
  if (!result.smoke && !result.input) throw new Error('Provide --smoke or --input <path>')
  result.player = String(result.player)
  if (!result.player.trim()) throw new Error('--player must be non-empty')
  result.goal = String(result.goal)
  if (!result.goal.trim()) throw new Error('--goal must be non-empty')
  if (result.seed !== undefined) result.seed = parseUint32(result.seed, '--seed')
  result.maxNodes = parseBound(result.maxNodes, '--max-nodes', 1)
  result.maxDepth = parseBound(result.maxDepth, '--max-depth', 0)
  result.maxTimeMs = parseBound(result.maxTimeMs, '--max-time-ms', 0)
  return result
}

function readInput(path) {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'))
  if (!value || typeof value !== 'object' || !value.turn || !Array.isArray(value.players)) {
    throw new Error('--input must contain a complete offline BattleState JSON object')
  }
  return value
}

async function buildRuntime() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-goal-search-'))
  const outfile = join(temporaryDirectory, 'runtime.cjs')
  const source = `
    import { projectOfflineGoalResult, runOfflineGoalSearch } from ${JSON.stringify(resolve(root, 'lib/ai-bot/offline-goal-cli.ts'))}

    export async function run(payload) {
      const options = {
        smoke: payload.smoke,
        state: payload.state,
        playerId: payload.player,
        rootSeed: payload.seed,
        goalTemplateId: payload.goal,
        bounds: {
          maxNodes: payload.maxNodes,
          maxDepth: payload.maxDepth,
          maxTimeMs: payload.maxTimeMs,
        },
      }
      const run = await runOfflineGoalSearch(options)
      return projectOfflineGoalResult(run, options)
    }
  `
  await build({
    absWorkingDir: root,
    tsconfig: resolve(root, 'tsconfig.json'),
    stdin: { contents: source, loader: 'ts', resolveDir: root, sourcefile: 'goal-search-runtime.ts' },
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
  if (args.smoke && args.seed === undefined) args.seed = 0x8b0139
  if (!args.smoke && args.seed === undefined) throw new Error('--seed is required with --input')
  const state = args.input ? readInput(args.input) : undefined
  const { runtime, cleanup } = await buildRuntime()
  try {
    const result = await runtime.run({
      smoke: Boolean(args.smoke), state, player: args.player, seed: args.seed,
      goal: args.goal, maxNodes: args.maxNodes, maxDepth: args.maxDepth, maxTimeMs: args.maxTimeMs,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.status === 'invalid-input') process.exitCode = 2
  } finally {
    cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`[ai:goal-search] ${error?.stack || error}\n`)
  process.exitCode = 1
})
