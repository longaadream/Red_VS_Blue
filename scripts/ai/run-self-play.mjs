import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const root = resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const INTERNAL_WORKER = '--internal-worker'
const PROGRESS_ACTION_INTERVAL = 20

function usage() {
  console.log(`Usage: npm run ai:self-play -- [options]

Options:
  --smoke                Run the paired 2-match human acceptance suite
  --suite <path>         Suite config (default: config/ai/suites/fixed-baseline-v1.json)
  --seeds <a,b,...>      Run a subset of the selected non-secret seed tier
  --holdout-file <path>  Private JSON { "seeds": [...], "commitmentHash": "..." }
  --output <path>        Report JSON path (default: output/ai-self-play/<unique>.json)
  --processes <n>        Maximum isolated match processes (default: 1)
  --resume <path>        Resume from an automatically written checkpoint JSON
  --verbose              Preserve existing rule-engine stdout
  --help                 Show this help
`)
}

function parseArgs(argv) {
  const result = { processes: 1, smoke: false, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--help') result.help = true
    else if (value === '--smoke') result.smoke = true
    else if (value === '--verbose') result.verbose = true
    else if (['--suite', '--seeds', '--holdout-file', '--output', '--processes', '--resume'].includes(value)) {
      const next = argv[++index]
      if (!next) throw new Error(`${value} requires a value`)
      result[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next
    } else throw new Error(`Unknown argument ${value}`)
  }
  if (result.smoke && result.suite) throw new Error('--smoke and --suite cannot be used together')
  result.processes = Number(result.processes)
  if (!Number.isSafeInteger(result.processes) || result.processes < 1 || result.processes > cpus().length) {
    throw new Error(`--processes must be an integer between 1 and ${cpus().length}`)
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

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function parseSeeds(value) {
  if (!value) return undefined
  const seeds = value.split(',').map(token => Number(token.trim()))
  if (!seeds.length || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)) {
    throw new Error('--seeds must be a comma-separated list of uint32 integers')
  }
  if (new Set(seeds).size !== seeds.length) throw new Error('--seeds must not contain duplicates')
  return seeds
}

function selectedSeedsForSuite(suite, seedPartitions, explicitSeeds) {
  const tierSeeds = suite.seedTier === 'training'
    ? seedPartitions.training
    : suite.seedTier === 'public-validation'
      ? seedPartitions.publicValidation
      : explicitSeeds
  if (!Array.isArray(tierSeeds) || tierSeeds.length === 0) {
    throw new Error(`${suite.seedTier} requires at least one seed`)
  }
  if (!explicitSeeds || suite.seedTier === 'candidate-holdout') return [...tierSeeds]
  const admitted = new Set(tierSeeds)
  const unknown = explicitSeeds.filter(seed => !admitted.has(seed))
  if (unknown.length) throw new Error(`seeds are outside ${suite.seedTier}: ${unknown.join(',')}`)
  return explicitSeeds
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
    import {
      buildPairedMatchSchedule, buildSelfPlayReport, createSelfPlayProcessExecutionMode,
      runSelfPlayMatch,
    } from ${runnerPath}
    import { createInitialBattleForPlayers, DEMO_DEPLOYMENT_MAP_ID } from ${setupPath}
    import { getPieceById } from ${piecesPath}

    async function createInitialState(input: any) {
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
    }

    export async function executeMatch(payload: any, onProgress?: (event: any) => void) {
      const originalLog = console.log
      if (!payload.verbose) console.log = () => {}
      try {
        const candidatePlayerId = payload.swapIndex === 0 ? 'player-red' : 'player-blue'
        const opponentPlayerId = payload.swapIndex === 0 ? 'player-blue' : 'player-red'
        const scheduled = buildPairedMatchSchedule(payload.manifest, [payload.rootSeed]).find((match: any) =>
          match.rootSeed === payload.rootSeed
          && match.lineupId === payload.lineupId
          && match.swapIndex === payload.swapIndex
          && match.seats[candidatePlayerId].agentId === payload.manifest.candidateAgentId
          && match.seats[opponentPlayerId].agentId === payload.opponentAgentId
        )
        if (!scheduled) throw new Error('Unable to resolve deterministic scheduled match')
        return await runSelfPlayMatch({
          manifest: payload.manifest,
          seedPartitions: payload.seedPartitions,
          explicitSeeds: [payload.rootSeed],
          agentArchives: payload.agentArchives,
          rosterArchives: payload.rosterArchives,
          execution: { inProcessConcurrency: 1, processCount: 1 },
          hardware: payload.hardware,
          createInitialState,
          onProgress,
        }, scheduled)
      } finally {
        console.log = originalLog
      }
    }

    export function finalize(payload: any) {
      return buildSelfPlayReport({
        manifest: payload.manifest,
        seeds: payload.seeds,
        agentArchives: payload.agentArchives,
        rosterArchives: payload.rosterArchives,
        execution: createSelfPlayProcessExecutionMode(payload.processCount),
        matches: payload.matches,
        elapsedMs: payload.elapsedMs,
        hardware: payload.hardware,
      })
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

function checkpointPathFor(reportPath) {
  const base = reportPath.endsWith('.json') ? reportPath.slice(0, -5) : reportPath
  return `${base}.checkpoint.json`
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
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

function buildJobs(manifest, seeds) {
  const jobs = []
  for (const [opponentIndex, opponentAgentId] of manifest.opponentAgentIds.entries()) {
    for (const [lineupIndex, lineup] of manifest.lineups.entries()) {
      for (const [seedIndex, rootSeed] of seeds.entries()) {
        for (const swapIndex of [0, 1]) {
          const order = jobs.length
          jobs.push({
            key: `${opponentIndex}:${lineupIndex}:${seedIndex}:${swapIndex}`,
            order,
            opponentAgentId,
            lineupId: lineup.lineupId,
            rootSeed,
            swapIndex,
          })
        }
      }
    }
  }
  return jobs
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '计算中'
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [hours ? `${hours}时` : '', minutes || hours ? `${minutes}分` : '', `${seconds}秒`].join('')
}

function runWorker(payload, verbose, onMessage = () => {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-ai-self-play-job-'))
  const inputPath = join(temporaryDirectory, 'input.json')
  const outputPath = join(temporaryDirectory, 'output.json')
  writeFileSync(inputPath, `${JSON.stringify(payload)}\n`)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = fork(scriptPath, [INTERNAL_WORKER, inputPath, outputPath], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout?.on('data', chunk => { if (verbose) process.stdout.write(chunk) })
    child.stderr?.on('data', chunk => process.stderr.write(chunk))
    child.on('message', onMessage)
    child.on('error', rejectPromise)
    child.on('exit', code => {
      try {
        if (code !== 0) throw new Error(`isolated self-play worker exited with code ${code}`)
        resolvePromise(readJson(outputPath))
      } catch (error) {
        rejectPromise(error)
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      }
    })
  })
}

async function workerMain(inputPath, outputPath) {
  process.chdir(root)
  const payload = readJson(resolve(inputPath))
  const { runtime, cleanup } = await buildRuntime()
  try {
    let result
    if (payload.kind === 'match') {
      result = await runtime.executeMatch(payload.input, event => {
        if (event.kind === 'action-completed'
          && event.actionCount !== 1
          && event.actionCount % PROGRESS_ACTION_INTERVAL !== 0
          && event.actionCount !== event.maxActions) return
        process.send?.({ type: 'progress', event })
      })
    } else if (payload.kind === 'finalize') {
      result = runtime.finalize(payload.input)
    } else throw new Error(`Unknown worker kind ${payload.kind}`)
    writeFileSync(resolve(outputPath), `${JSON.stringify(result)}\n`)
  } finally {
    cleanup()
  }
}

async function runPool(items, concurrency, task) {
  let cursor = 0
  const slots = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await task(items[index])
    }
  })
  await Promise.all(slots)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  process.chdir(root)
  const suitePath = resolveFromRoot(args.smoke
    ? 'config/ai/suites/human-smoke-v1.json'
    : args.suite ?? 'config/ai/suites/fixed-baseline-v1.json')
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
    evaluationScope: suite.evaluationScope ?? 'baseline',
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
  const seeds = selectedSeedsForSuite(suite, seedPartitions, explicitSeeds)
  const jobs = buildJobs(manifest, seeds)
  const processCount = Math.min(args.processes, jobs.length)
  const resumed = args.resume ? readJson(resolve(args.resume)) : undefined
  const reportProcessCount = Math.max(resumed?.processCount ?? 1, processCount)
  const reportPath = resolve(args.output ?? resumed?.reportPath ?? defaultOutputPath(suite.suiteId, commit))
  const checkpointPath = args.resume ? resolve(args.resume) : checkpointPathFor(reportPath)
  const commitment = hashValue({ manifest, seeds, agentArchives, rosterArchives })
  if (resumed && (resumed.kind !== 'rvb-self-play-checkpoint-v1' || resumed.commitment !== commitment)) {
    throw new Error('checkpoint does not match the current suite, commit, rules, content, seeds, or archives')
  }
  if (resumed?.status === 'complete') {
    console.log(`[自博弈] 检查点已完成：${checkpointPath}`)
    console.log(JSON.stringify(resumed.artifacts, null, 2))
    return
  }

  const completedByKey = new Map()
  for (const entry of resumed?.completed ?? []) {
    if (completedByKey.has(entry.jobKey) || !jobs.some(job => job.key === entry.jobKey)) {
      throw new Error(`checkpoint contains invalid or duplicate job ${entry.jobKey}`)
    }
    completedByKey.set(entry.jobKey, entry.match)
  }
  const startedAt = Date.now() - (resumed?.elapsedMs ?? 0)
  const checkpoint = {
    schemaVersion: 1,
    kind: 'rvb-self-play-checkpoint-v1',
    status: 'in-progress',
    commitment,
    suiteId: suite.suiteId,
    codeCommit: commit,
    reportPath,
    processCount: reportProcessCount,
    elapsedMs: resumed?.elapsedMs ?? 0,
    completed: [...completedByKey.entries()].map(([jobKey, match]) => ({ jobKey, match })),
  }
  writeJsonAtomically(checkpointPath, checkpoint)

  const pending = jobs.filter(job => !completedByKey.has(job.key))
  const scope = args.smoke ? '人工快速验收（换边 2 局）' : '完整固定基线'
  console.log(`[自博弈] ${scope}；共 ${jobs.length} 局；并行上限 ${processCount}；已完成 ${completedByKey.size}`)
  console.log(`[自博弈] 每局使用独立子进程，完成后释放；检查点：${checkpointPath}`)

  const activeStartedAt = new Map()
  const eta = () => {
    if (completedByKey.size === 0) return Number.NaN
    const averageMatchMs = [...completedByKey.values()]
      .reduce((total, match) => total + match.durationMs, 0) / completedByKey.size
    const activeElapsedMs = [...activeStartedAt.values()].map(matchStartedAt => Date.now() - matchStartedAt)
    if (activeElapsedMs.some(elapsedMs => elapsedMs >= averageMatchMs)) return Number.NaN
    const activeRemainingMs = activeElapsedMs
      .reduce((total, elapsedMs) => total + averageMatchMs - elapsedMs, 0)
    const waitingMatches = Math.max(0, jobs.length - completedByKey.size - activeStartedAt.size)
    return activeRemainingMs + waitingMatches * averageMatchMs
  }
  await runPool(pending, processCount, async job => {
    const display = `${job.opponentAgentId}/${job.lineupId}/换边${job.swapIndex}`
    activeStartedAt.set(job.key, Date.now())
    console.log(`[进度 ${completedByKey.size}/${jobs.length}] 开始第 ${job.order + 1} 局：${display}`)
    const match = await runWorker({
      kind: 'match',
      input: {
        manifest,
        seedPartitions,
        agentArchives,
        rosterArchives,
        hardware: hardwareDescription(),
        verbose: args.verbose,
        rootSeed: job.rootSeed,
        opponentAgentId: job.opponentAgentId,
        lineupId: job.lineupId,
        swapIndex: job.swapIndex,
      },
    }, args.verbose, message => {
      if (message?.type !== 'progress' || message.event.kind !== 'action-completed') return
      const event = message.event
      console.log(
        `[进度 ${completedByKey.size}/${jobs.length}] 第 ${job.order + 1} 局 ${display}`
        + `；动作 ${event.actionCount}/${event.maxActions}；回合 ${event.turnNumber}`
        + `；已用 ${formatDuration(Date.now() - startedAt)}；预计剩余 ${formatDuration(eta())}`,
      )
    })
    completedByKey.set(job.key, match)
    activeStartedAt.delete(job.key)
    checkpoint.processCount = reportProcessCount
    checkpoint.elapsedMs = Date.now() - startedAt
    checkpoint.completed = jobs
      .filter(item => completedByKey.has(item.key))
      .map(item => ({ jobKey: item.key, match: completedByKey.get(item.key) }))
    writeJsonAtomically(checkpointPath, checkpoint)
    const result = match.status === 'finished' ? '完成' : `失败(${match.failure?.kind ?? 'unknown'})`
    console.log(
      `[进度 ${completedByKey.size}/${jobs.length}] 第 ${job.order + 1} 局${result}`
      + `；动作 ${match.actionCount}；本局 ${formatDuration(match.durationMs)}`
      + `；预计剩余 ${formatDuration(eta())}`,
    )
  })

  const elapsedMs = Date.now() - startedAt
  const matches = jobs.map(job => completedByKey.get(job.key))
  const report = await runWorker({
    kind: 'finalize',
    input: {
      manifest,
      seeds,
      agentArchives,
      rosterArchives,
      matches,
      processCount: reportProcessCount,
      elapsedMs,
      hardware: hardwareDescription(),
    },
  }, args.verbose)
  const paths = writeArtifacts(report, reportPath)
  checkpoint.status = 'complete'
  checkpoint.elapsedMs = elapsedMs
  checkpoint.artifacts = paths
  writeJsonAtomically(checkpointPath, checkpoint)
  console.log(JSON.stringify({
    mode: manifest.evaluationScope === 'smoke' ? 'paired-human-smoke' : 'full-baseline',
    baselineEligible: manifest.evaluationScope !== 'smoke' && report.promotionGate.hardGatePassed,
    status: report.promotionGate.status,
    hardGatePassed: report.promotionGate.hardGatePassed,
    matches: report.summary.totalMatches,
    actions: report.summary.totalActions,
    checkpointPath,
    ...paths,
  }, null, 2))
  if (!report.promotionGate.hardGatePassed) process.exitCode = 2
}

const workerIndex = process.argv.indexOf(INTERNAL_WORKER)
const entry = workerIndex >= 0
  ? workerMain(process.argv[workerIndex + 1], process.argv[workerIndex + 2])
  : main()
entry.catch(error => {
  console.error(`[ai:self-play] ${error?.stack || error}`)
  process.exitCode = 1
})
