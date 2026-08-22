import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)

function usage() {
  console.log(`Usage: npm run ai:self-play -- [options]

Options:
  --suite <path>         Suite config (default: config/ai/suites/fixed-baseline-v1.json)
  --seeds <a,b,...>      Run a subset of the selected non-secret seed tier
  --holdout-file <path>  Private JSON { "seeds": [...], "commitmentHash": "..." }
  --output <path>        Report JSON path (default: output/ai-self-play/<unique>.json)
  --processes <n>        Must be 1 until process-isolation blocker is resolved
  --verbose              Preserve existing rule-engine stdout
  --help                 Show this help
`)
}

function parseArgs(argv) {
  const result = { processes: 1, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--help') result.help = true
    else if (value === '--verbose') result.verbose = true
    else if (['--suite', '--seeds', '--holdout-file', '--output', '--processes'].includes(value)) {
      const next = argv[++index]
      if (!next) throw new Error(`${value} requires a value`)
      result[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next
    } else throw new Error(`Unknown option ${value}`)
  }
  result.processes = Number(result.processes)
  if (result.processes !== 1) {
    throw new Error('Process-parallel orchestration is not implemented; --processes must be 1')
  }
  return result
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function resolveFromRoot(path) {
  return resolve(root, path)
}

function filesUnder(directory) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(absolute))
    else if (entry.isFile() && extname(entry.name) === '.json') result.push(absolute)
  }
  return result
}

function hashTrees(directories) {
  const hash = createHash('sha256')
  const files = directories.flatMap(directory => filesUnder(directory))
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right), 'en'))
  for (const file of files) {
    hash.update(relative(root, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function parseSeeds(value) {
  if (!value) return undefined
  const seeds = value.split(',').map(token => Number(token.trim()))
  if (!seeds.length || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)) {
    throw new Error('--seeds must be a comma-separated list of uint32 integers')
  }
  return seeds
}

function hardwareDescription() {
  return [
    `${platform()} ${release()} ${arch()}`,
    `node ${process.version}`,
    `${cpus().length} logical CPU (${cpus()[0]?.model ?? 'unknown'})`,
    `${Math.round(totalmem() / (1024 ** 3))} GiB RAM`,
  ].join('; ')
}

async function buildRuntime() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-ai-self-play-'))
  const outfile = join(temporaryDirectory, 'runtime.cjs')
  const runnerPath = JSON.stringify(resolveFromRoot('lib/game/ai-match-runner.ts'))
  const setupPath = JSON.stringify(resolveFromRoot('lib/game/battle-setup.ts'))
  const piecesPath = JSON.stringify(resolveFromRoot('lib/game/piece-repository.ts'))
  const source = `
    import { runSelfPlaySuite } from ${runnerPath}
    import { createInitialBattleForPlayers, DEMO_DEPLOYMENT_MAP_ID } from ${setupPath}
    import { getPieceById } from ${piecesPath}

    export async function execute(payload: any) {
      const originalLog = console.log
      if (!payload.verbose) console.log = () => {}
      try {
        return await runSelfPlaySuite({
          ...payload,
          createInitialState: async (input: any) => {
            const playerIds = ['player-red', 'player-blue']
            const playerSelectedPieces = playerIds.map(playerId => {
              const roster = input.rosters[playerId]
              const pieces = roster.pieceIds.map((pieceId: string) => {
                const piece = getPieceById(pieceId)
                if (!piece) throw new Error('Unknown roster piece ' + pieceId + ' in ' + roster.rosterId)
                return piece
              })
              if (pieces.length !== 8) throw new Error(roster.rosterId + ' must contain exactly eight pieces')
              return { playerId, faction: roster.faction, pieces }
            })
            const selectedPieces = playerSelectedPieces.flatMap(entry => entry.pieces)
            const state = await createInitialBattleForPlayers(
              playerIds,
              selectedPieces,
              playerSelectedPieces,
              DEMO_DEPLOYMENT_MAP_ID,
              {
                firstPlayerId: 'player-red',
                rootSeed: input.rootSeed,
                deploymentEnabled: true,
                deploymentStartedAt: 0,
              },
            )
            if (!state) throw new Error('Battle setup returned null')
            return state
          },
        })
      } finally {
        console.log = originalLog
      }
    }
  `
  await build({
    absWorkingDir: root,
    stdin: { contents: source, loader: 'ts', resolveDir: root, sourcefile: 'self-play-runtime.ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent',
  })
  return {
    runtime: require(outfile),
    cleanup: () => rmSync(temporaryDirectory, { recursive: true, force: true }),
  }
}

function codeCommit() {
  if (process.env.RVB_AI_CODE_COMMIT) return process.env.RVB_AI_CODE_COMMIT
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function defaultOutputPath(suiteId, commit) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return resolveFromRoot(join('output', 'ai-self-play', `${suiteId}-${commit.slice(0, 12)}-${stamp}.json`))
}

function writeArtifacts(report, reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  const base = reportPath.endsWith('.json') ? reportPath.slice(0, -5) : reportPath
  const matchesPath = `${base}.matches.ndjson`
  const summaryPath = `${base}.summary.json`
  writeFileSync(matchesPath, `${report.matches.map(match => JSON.stringify(match)).join('\n')}\n`, { flag: 'wx' })
  writeFileSync(summaryPath, `${JSON.stringify({
    schemaVersion: report.schemaVersion,
    suiteId: report.suiteId,
    rulesHash: report.rulesHash,
    contentHash: report.contentHash,
    codeCommit: report.codeCommit,
    execution: report.execution,
    summary: report.summary,
    promotionGate: report.promotionGate,
    performance: report.performance,
  }, null, 2)}\n`, { flag: 'wx' })
  return { reportPath, matchesPath, summaryPath }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  process.chdir(root)
  const suitePath = resolveFromRoot(args.suite ?? 'config/ai/suites/fixed-baseline-v1.json')
  const suite = readJson(suitePath)
  const seedPartitions = readJson(resolveFromRoot('config/ai/seeds.v1.json'))
  let explicitSeeds = parseSeeds(args.seeds)
  if (suite.seedTier === 'candidate-holdout') {
    if (!args.holdoutFile) throw new Error('candidate-holdout requires --holdout-file')
    const holdout = readJson(resolve(args.holdoutFile))
    explicitSeeds = holdout.seeds
    seedPartitions.candidateHoldout.commitmentHash = holdout.commitmentHash
  } else if (args.holdoutFile) {
    throw new Error('--holdout-file is only allowed for candidate-holdout suites')
  }

  const commit = codeCommit()
  const manifest = {
    schemaVersion: suite.schemaVersion,
    suiteId: suite.suiteId,
    seedTier: suite.seedTier,
    candidateAgentId: suite.candidateAgentId,
    opponentAgentIds: suite.opponentAgentIds,
    lineups: suite.lineups,
    budgets: suite.budgets,
    rulesHash: hashTrees([resolveFromRoot('data/rules')]),
    contentHash: hashTrees([
      resolveFromRoot('data/cards'), resolveFromRoot('data/maps'),
      resolveFromRoot('data/pieces'), resolveFromRoot('data/skills'),
    ]),
    codeCommit: commit,
  }
  const agentArchives = suite.agentArchiveFiles.map(path => readJson(resolveFromRoot(path)))
  const rosterArchives = suite.rosterArchiveFiles.map(path => readJson(resolveFromRoot(path)))
  const { runtime, cleanup } = await buildRuntime()
  try {
    const report = await runtime.execute({
      manifest,
      seedPartitions,
      explicitSeeds,
      agentArchives,
      rosterArchives,
      execution: { inProcessConcurrency: 1, processCount: 1 },
      hardware: hardwareDescription(),
      verbose: args.verbose,
    })
    const paths = writeArtifacts(report, resolve(args.output ?? defaultOutputPath(suite.suiteId, commit)))
    console.log(JSON.stringify({
      status: report.promotionGate.status,
      hardGatePassed: report.promotionGate.hardGatePassed,
      matches: report.summary.totalMatches,
      actions: report.summary.totalActions,
      ...paths,
    }, null, 2))
    if (!report.promotionGate.hardGatePassed) process.exitCode = 2
  } finally {
    cleanup()
  }
}

main().catch(error => {
  console.error(`[ai:self-play] ${error?.stack || error}`)
  process.exitCode = 1
})
