import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..', '..')
const require = createRequire(import.meta.url)
const INTERNAL_WORKER = '--internal-worker'
const DEFAULT_CONFIG = 'config/ai/linear-training-v1.json'
const DEFAULT_RUN = 'output/ai-training/red-110-linear-greedy-v1'
const PROGRESS_INTERVAL_MS = 5_000

function usage() {
  console.log(`Usage: npm run ai:train:linear -- <command> [options]

Commands:
  init       Create a durable run in awaiting-user state
  next       Run exactly one new generation, archive it, then exit
  resume     Continue the current paused/interrupted generation
  pause      Request a running generation to stop dispatching and drain workers
  status     Print the durable progress snapshot; add --watch to refresh
  sync       Retry compact GitHub branch synchronization
  smoke      Run one mirrored pair (four matches) through the real rules

Options:
  --run <directory>       Run directory (default: ${DEFAULT_RUN})
  --config <path>         Training config (default: ${DEFAULT_CONFIG})
  --processes <n>         Isolated match processes (default: config value 3)
  --github-sync           Enable configured branch commit/push for this command
  --no-github-sync        Keep artifacts local for this command
  --watch                 Refresh status every five seconds
  --verbose               Preserve rule-engine stdout
`)
}

function parseArgs(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === 'help') return { help: true }
  if (!['init', 'next', 'resume', 'pause', 'status', 'sync', 'smoke'].includes(command)) {
    throw new Error(`Unknown command ${command}`)
  }
  const result = { command, githubSync: undefined, verbose: false, watch: false }
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--github-sync') result.githubSync = true
    else if (value === '--no-github-sync') result.githubSync = false
    else if (value === '--verbose') result.verbose = true
    else if (value === '--watch') result.watch = true
    else if (['--run', '--config', '--processes'].includes(value)) {
      const next = argv[++index]
      if (!next) throw new Error(`${value} requires a value`)
      result[value.slice(2)] = next
    } else throw new Error(`Unknown argument ${value}`)
  }
  if (result.processes !== undefined) {
    result.processes = Number(result.processes)
    if (!Number.isSafeInteger(result.processes) || result.processes <= 0 || result.processes > cpus().length) {
      throw new Error(`--processes must be between 1 and ${cpus().length}`)
    }
  }
  return result
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const fromRoot = path => resolve(root, path)

function filesUnder(directory, extensions) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(absolute, extensions))
    else if (entry.isFile() && extensions.has(extname(entry.name))) result.push(absolute)
  }
  return result
}

function hashFiles(files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => relative(root, a).localeCompare(relative(root, b), 'en'))) {
    hash.update(relative(root, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function sourceHashes() {
  return {
    codeHash: hashFiles([
      ...filesUnder(fromRoot('lib/game'), new Set(['.ts'])),
      fromRoot('scripts/ai/train-linear.mjs'),
    ]),
    rulesHash: hashFiles(filesUnder(fromRoot('data/rules'), new Set(['.json']))),
    contentHash: hashFiles([
      ...filesUnder(fromRoot('data/cards'), new Set(['.json'])),
      ...filesUnder(fromRoot('data/maps'), new Set(['.json'])),
      ...filesUnder(fromRoot('data/pieces'), new Set(['.json'])),
      ...filesUnder(fromRoot('data/skills'), new Set(['.json'])),
    ]),
  }
}

function trainingConfigHash(configPath, config) {
  return hashFiles([
    configPath,
    fromRoot(config.seedFile),
    fromRoot(config.seedAgentFile),
    ...config.opponentAgentFiles.map(fromRoot),
    ...config.rosterArchiveFiles.map(fromRoot),
  ])
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

function appendEvent(runDirectory, event) {
  mkdirSync(runDirectory, { recursive: true })
  appendFileSync(join(runDirectory, 'events.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function codeCommit() {
  return git('rev-parse', 'HEAD')
}

async function buildRuntime() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-ai-linear-'))
  const outfile = join(temporaryDirectory, 'runtime.cjs')
  const trainingPath = JSON.stringify(fromRoot('lib/game/ai-linear-training.ts'))
  const githubPath = JSON.stringify(fromRoot('lib/game/ai-linear-github.ts'))
  const featuresPath = JSON.stringify(fromRoot('lib/game/ai-linear-features.ts'))
  const matchPath = JSON.stringify(fromRoot('lib/game/ai-match-runner.ts'))
  const setupPath = JSON.stringify(fromRoot('lib/game/ai-self-play-setup.ts'))
  const source = `
    export * from ${trainingPath}
    export * from ${githubPath}
    export { AI_LINEAR_FEATURE_NAMES, AI_LINEAR_FEATURE_SCHEMA_HASH } from ${featuresPath}
    import { buildPairedMatchSchedule, runSelfPlayMatch } from ${matchPath}
    import { createSelfPlayInitialState } from ${setupPath}

    export async function executeLinearMatch(payload: any, onProgress?: (event: any) => void) {
      const originalLog = console.log
      if (!payload.verbose) console.log = () => {}
      try {
        const candidatePlayerId = payload.job.swapIndex === 0 ? 'player-red' : 'player-blue'
        const opponentPlayerId = payload.job.swapIndex === 0 ? 'player-blue' : 'player-red'
        const scheduled = buildPairedMatchSchedule(payload.manifest, [payload.job.rootSeed]).find((match: any) =>
          match.rootSeed === payload.job.rootSeed
          && match.lineupId === payload.job.lineupId
          && match.swapIndex === payload.job.swapIndex
          && match.seats[candidatePlayerId].agentId === payload.manifest.candidateAgentId
          && match.seats[opponentPlayerId].agentId === payload.job.opponentAgentId
        )
        if (!scheduled) throw new Error('Unable to resolve linear training match')
        return runSelfPlayMatch({
          manifest: payload.manifest,
          seedPartitions: payload.seedPartitions,
          explicitSeeds: [payload.job.rootSeed],
          agentArchives: payload.agentArchives,
          rosterArchives: payload.rosterArchives,
          execution: { inProcessConcurrency: 1, processCount: 1 },
          createInitialState: createSelfPlayInitialState,
          onProgress,
        }, scheduled)
      } finally {
        console.log = originalLog
      }
    }
  `
  await build({
    absWorkingDir: root,
    stdin: { contents: source, loader: 'ts', resolveDir: root, sourcefile: 'linear-training-runtime.ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', sourcemap: false,
  })
  return { runtime: require(outfile), cleanup: () => rmSync(temporaryDirectory, { recursive: true, force: true }) }
}

function runWorker(payload, verbose, onMessage) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-ai-linear-job-'))
  const inputPath = join(temporaryDirectory, 'input.json')
  const outputPath = join(temporaryDirectory, 'output.json')
  writeFileSync(inputPath, `${JSON.stringify(payload)}\n`)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = fork(scriptPath, [INTERNAL_WORKER, inputPath, outputPath], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout?.on('data', chunk => { if (verbose) process.stdout.write(chunk) })
    child.stderr?.on('data', chunk => process.stderr.write(chunk))
    child.on('message', onMessage)
    child.on('error', rejectPromise)
    child.on('exit', code => {
      try {
        if (code !== 0) throw new Error(`linear match worker exited with code ${code}`)
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
    const result = await runtime.executeLinearMatch(payload, event => {
      if (event.kind === 'action-completed' && event.actionCount !== 1 && event.actionCount % 20 !== 0) return
      process.send?.({ type: 'progress', event })
    })
    writeFileSync(resolve(outputPath), `${JSON.stringify(result)}\n`)
  } finally {
    cleanup()
  }
}

function selectGenerationInputs(config, generation, seedPartitions, smoke = false) {
  const seedCount = smoke ? 1 : config.seedsPerGeneration
  const start = ((generation - 1) * config.seedsPerGeneration) % seedPartitions.training.length
  const rootSeeds = Array.from({ length: seedCount }, (_, offset) => seedPartitions.training[(start + offset) % seedPartitions.training.length])
  const lineup = config.lineups[(generation - 1) % config.lineups.length]
  const opponentFiles = smoke ? config.opponentAgentFiles.slice(0, 1) : config.opponentAgentFiles
  return { rootSeeds, lineup, opponentFiles }
}

function loadConfig(path) {
  const config = readJson(path)
  if (config.schemaVersion !== 1 || config.populationSize !== config.pairCount * 2) {
    throw new Error('linear training config must use schema 1 and populationSize=pairCount*2')
  }
  if (config.seedsPerGeneration !== 2 || config.lineups.length < 1 || config.opponentAgentFiles.length !== 2) {
    throw new Error('RED-110 requires exactly two seeds, one selected lineup, and two opponents per generation')
  }
  if (!Number.isSafeInteger(config.maxCandidatesPerAction) || config.maxCandidatesPerAction <= 0) {
    throw new Error('maxCandidatesPerAction must be a positive integer')
  }
  return config
}

function pathsFor(runDirectory) {
  return {
    runPath: join(runDirectory, 'run.json'),
    progressPath: join(runDirectory, 'progress.json'),
  }
}

function writeProgress(runtime, runDirectory, run, activeWorkers = [], githubSync = run.githubSync ?? { status: 'not-requested' }) {
  const progress = {
    ...runtime.linearTrainingProgress(run),
    activeWorkers,
    updatedAt: new Date().toISOString(),
    githubSync,
    checkpoint: {
      path: 'run.json',
      completedMatches: run.activeGeneration?.matches.length ?? 0,
      savedAt: new Date().toISOString(),
    },
  }
  writeJsonAtomically(pathsFor(runDirectory).progressPath, progress)
  return progress
}

function displayProgress(progress, startedAt, processCount = 3) {
  const elapsed = Math.max(0, Date.now() - startedAt)
  const average = progress.completed > 0 ? progress.completedDurationMs / progress.completed : Number.NaN
  const eta = Number.isFinite(average)
    ? average * (progress.total - progress.completed) / Math.max(1, processCount)
    : Number.NaN
  const duration = value => !Number.isFinite(value) ? '计算中' : `${Math.floor(value / 3_600_000)}时${Math.floor(value % 3_600_000 / 60_000)}分`
  console.log(
    `[线性训练] 第${progress.generation}代 ${progress.completed}/${progress.total}`
    + `；运行 ${progress.activeWorkers.length}/3`
    + `；胜/平/负 ${progress.wins}/${progress.draws}/${progress.losses}`
    + `；硬失败 ${progress.hardGateFailures}`
    + `；已用 ${duration(elapsed)}；预计剩余 ${duration(eta)}`,
  )
  for (const worker of progress.activeWorkers) {
    console.log(`  worker-${worker.slot} ${worker.candidateId} seed=${worker.rootSeed} vs=${worker.opponentAgentId} 换边${worker.swapIndex} 回合=${worker.turnNumber ?? '-'} 动作=${worker.actionCount ?? '-'}`)
  }
}

function compactEvidence(run) {
  return {
    schemaVersion: run.schemaVersion,
    kind: run.kind,
    runId: run.runId,
    status: run.status,
    codeCommit: run.codeCommit,
    codeHash: run.codeHash,
    rulesHash: run.rulesHash,
    contentHash: run.contentHash,
    featureSchemaHash: run.featureSchemaHash,
    trainingConfigHash: run.trainingConfigHash,
    completedGeneration: run.completedGeneration,
    centerWeights: run.centerWeights,
    optimizerState: run.optimizerState,
    activeGeneration: run.activeGeneration ? {
      generation: run.activeGeneration.generation,
      status: run.activeGeneration.status,
      rootSeeds: run.activeGeneration.rootSeeds,
      lineupId: run.activeGeneration.lineupId,
      opponentAgentIds: run.activeGeneration.opponentAgentIds,
      commitment: run.activeGeneration.commitment,
      completedMatches: run.activeGeneration.matches,
      totalMatches: run.activeGeneration.schedule.length,
    } : undefined,
    archives: run.archives,
  }
}

function syncGitHub(runtime, config, run, reason) {
  const evidencePath = fromRoot(join(config.github.evidenceDirectory, 'latest.json'))
  const relativePath = relative(root, evidencePath).replaceAll('\\', '/')
  return runtime.syncLinearTrainingEvidence({
    currentBranch: () => git('branch', '--show-current'),
    writeEvidence: () => writeJsonAtomically(evidencePath, compactEvidence(run)),
    stage: path => { git('add', '--', path) },
    hasStagedChanges: path => {
      try { git('diff', '--cached', '--quiet', '--', path); return false } catch { return true }
    },
    commit: (message, path) => { git('commit', '--only', '-m', message, '--', path) },
    push: () => { git('push', 'origin', 'HEAD') },
    now: () => new Date().toISOString(),
  }, {
    requiredBranch: config.github.requiredBranch,
    taskId: 'RED-110',
    evidencePath: relativePath,
    evidence: compactEvidence(run),
    commitMessage: `ai(train): ${reason}`,
  })
}

async function runGeneration(runtime, config, runDirectory, run, processCount, verbose, maxCandidates = config.maxCandidatesPerAction) {
  const { runPath } = pathsFor(runDirectory)
  const active = run.activeGeneration
  if (!active || run.status !== 'running') throw new Error('No running generation')
  const completedIds = new Set(active.matches.map(match => match.jobId))
  const pending = active.schedule.filter(job => !completedIds.has(job.jobId))
  const seedPartitions = readJson(fromRoot(config.seedFile))
  const opponents = config.opponentAgentFiles.map(path => readJson(fromRoot(path)))
  const rosterArchives = config.rosterArchiveFiles.map(path => readJson(fromRoot(path)))
  const activeWorkers = new Map()
  const pauseRequestPath = join(runDirectory, 'pause-request.json')
  const startedAt = Date.now()
  let pauseRequested = false
  let cursor = 0
  let durableRun = run
  const onSignal = () => {
    if (pauseRequested) {
      console.error('[线性训练] 再次收到中断；在途对局不会计入 checkpoint，下次将重跑。')
      process.exit(130)
    }
    pauseRequested = true
    console.log('[线性训练] 已请求暂停；停止派发新局，等待最多 3 个在途对局结束。')
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const timer = setInterval(() => {
    if (!pauseRequested && existsSync(pauseRequestPath)) {
      pauseRequested = true
      console.log('[线性训练] 检测到持久化暂停请求；停止派发新局并排空在途对局。')
    }
    displayProgress(writeProgress(runtime, runDirectory, durableRun, [...activeWorkers.values()]), startedAt, processCount)
  }, PROGRESS_INTERVAL_MS)
  try {
    const workers = Array.from({ length: Math.min(processCount, pending.length) }, (_, slotIndex) => (async () => {
      while (!pauseRequested && cursor < pending.length) {
        const job = pending[cursor++]
        const candidate = active.population.find(item => item.candidateId === job.candidateId)
        if (!candidate) throw new Error(`Missing candidate ${job.candidateId}`)
        const candidateAgentId = `linear-${run.runId}-${job.candidateId}`
        const candidateArchive = {
          schemaVersion: 1, agentId: candidateAgentId, version: `generation-${active.generation}`,
          kind: 'linear-greedy',
          config: {
            version: 1, featureSchemaVersion: 1, minImprovement: 0, maxCandidates,
            weights: candidate.weights,
          },
        }
        const opponent = opponents.find(agent => agent.agentId === job.opponentAgentId)
        if (!opponent) throw new Error(`Missing opponent archive ${job.opponentAgentId}`)
        const manifest = {
          schemaVersion: 1,
          suiteId: `${run.runId}-g${active.generation}-${job.candidateId}`,
          evaluationScope: 'baseline', seedTier: 'training', candidateAgentId,
          opponentAgentIds: [job.opponentAgentId],
          lineups: [config.lineups.find(lineup => lineup.lineupId === job.lineupId)],
          budgets: config.budgets,
          rulesHash: run.rulesHash, contentHash: run.contentHash, codeCommit: run.codeCommit,
        }
        const workerState = {
          slot: slotIndex + 1, candidateId: job.candidateId, rootSeed: job.rootSeed,
          opponentAgentId: job.opponentAgentId, swapIndex: job.swapIndex,
        }
        activeWorkers.set(slotIndex, workerState)
        appendEvent(runDirectory, { kind: 'match-started', generation: active.generation, jobId: job.jobId, ...workerState })
        const fullMatch = await runWorker({
          job: { ...job, candidateId: candidateAgentId }, manifest, seedPartitions,
          agentArchives: [candidateArchive, ...opponents], rosterArchives, verbose,
        }, verbose, message => {
          if (message?.type !== 'progress') return
          const event = message.event
          activeWorkers.set(slotIndex, { ...workerState, actionCount: event.actionCount, turnNumber: event.turnNumber })
        })
        const match = {
          jobId: job.jobId,
          candidateId: job.candidateId,
          outcome: fullMatch.winnerAgentId === candidateAgentId ? 'win' : fullMatch.winnerAgentId ? 'loss' : 'draw',
          hardGatePassed: fullMatch.status === 'finished' && !fullMatch.failure,
          durationMs: fullMatch.durationMs,
          failureKind: fullMatch.failure?.kind,
        }
        durableRun = runtime.recordLinearTrainingMatch(durableRun, match)
        writeJsonAtomically(runPath, durableRun)
        const generationDirectory = join(runDirectory, `generation-${String(active.generation).padStart(4, '0')}`)
        mkdirSync(generationDirectory, { recursive: true })
        appendFileSync(join(generationDirectory, 'matches.ndjson'), `${JSON.stringify({ job, result: fullMatch })}\n`)
        appendEvent(runDirectory, { kind: 'match-completed', generation: active.generation, ...match })
        activeWorkers.delete(slotIndex)
        writeProgress(runtime, runDirectory, durableRun, [...activeWorkers.values()])
      }
    })())
    await Promise.all(workers)
  } finally {
    clearInterval(timer)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
  if (pauseRequested) {
    durableRun = runtime.pauseLinearGeneration(durableRun, 'user-requested')
    writeJsonAtomically(runPath, durableRun)
    rmSync(pauseRequestPath, { force: true })
    appendEvent(runDirectory, { kind: 'generation-paused', generation: active.generation, completed: durableRun.activeGeneration.matches.length })
    return { run: durableRun, paused: true }
  }
  const hardGateFailures = durableRun.activeGeneration.matches.filter(match => !match.hardGatePassed)
  if (hardGateFailures.length > 0) {
    durableRun = runtime.pauseLinearGeneration(durableRun, 'hard-gate-failure')
    writeJsonAtomically(runPath, durableRun)
    appendEvent(runDirectory, {
      kind: 'generation-blocked', generation: active.generation,
      hardGateFailures: hardGateFailures.length,
      failureKinds: [...new Set(hardGateFailures.map(match => match.failureKind ?? 'unknown'))],
    })
    console.error(`[线性训练] 本代有 ${hardGateFailures.length} 个硬失败；权重未更新。调整预算或排除故障后执行 resume 重跑失败局。`)
    return { run: durableRun, paused: true }
  }
  durableRun = runtime.completeLinearGeneration(durableRun, { learningRate: config.learningRate })
  writeJsonAtomically(runPath, durableRun)
  writeJsonAtomically(join(runDirectory, `generation-${String(active.generation).padStart(4, '0')}`, 'summary.json'), compactEvidence(durableRun))
  appendEvent(runDirectory, { kind: 'generation-completed', generation: active.generation })
  return { run: durableRun, paused: false }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()
  process.chdir(root)
  const configPath = resolve(args.config ?? fromRoot(DEFAULT_CONFIG))
  const config = loadConfig(configPath)
  const runDirectory = resolve(args.run ?? fromRoot(DEFAULT_RUN))
  const { runPath } = pathsFor(runDirectory)
  const { runtime, cleanup } = await buildRuntime()
  try {
    if (args.command === 'init' || args.command === 'smoke') {
      const targetDirectory = args.command === 'smoke'
        ? resolve(args.run ?? join(tmpdir(), `rvb-linear-smoke-${Date.now()}`))
        : runDirectory
      const targetRunPath = pathsFor(targetDirectory).runPath
      if (existsSync(targetRunPath)) throw new Error(`Run already exists: ${targetRunPath}`)
      const hashes = sourceHashes()
      const seedAgent = readJson(fromRoot(config.seedAgentFile))
      let run = runtime.createLinearTrainingRun({
        runId: args.command === 'smoke' ? `${config.runId}-smoke` : config.runId,
        codeCommit: codeCommit(), ...hashes,
        featureSchemaHash: runtime.AI_LINEAR_FEATURE_SCHEMA_HASH,
        trainingConfigHash: trainingConfigHash(configPath, config),
        centerWeights: seedAgent.config.weights,
        optimizerSeed: config.optimizerSeed,
      })
      mkdirSync(targetDirectory, { recursive: true })
      writeJsonAtomically(targetRunPath, run)
      appendEvent(targetDirectory, { kind: 'run-created', runId: run.runId })
      if (args.command === 'init') {
        writeProgress(runtime, targetDirectory, run)
        console.log(JSON.stringify({ status: run.status, runId: run.runId, runDirectory: targetDirectory }, null, 2))
        return
      }
      console.log(`[线性训练] smoke 目录：${targetDirectory}`)
      const seedPartitions = readJson(fromRoot(config.seedFile))
      const selected = selectGenerationInputs(config, 1, seedPartitions, true)
      run = runtime.beginLinearGeneration(run, {
        rootSeeds: selected.rootSeeds,
        lineupId: selected.lineup.lineupId,
        opponentAgentIds: selected.opponentFiles.map(path => readJson(fromRoot(path)).agentId),
        pairCount: 1,
        sigma: config.sigma,
      })
      writeJsonAtomically(targetRunPath, run)
      const result = await runGeneration(
        runtime, config, targetDirectory, run,
        Math.min(args.processes ?? config.processCount, 3), args.verbose, 4,
      )
      writeProgress(runtime, targetDirectory, result.run)
      console.log(JSON.stringify({ smoke: true, status: result.run.status, completedGeneration: result.run.completedGeneration, runDirectory: targetDirectory }, null, 2))
      return
    }

    if (!existsSync(runPath)) throw new Error(`Run does not exist; initialize first: ${runPath}`)
    let run = readJson(runPath)
    if (args.command === 'status') {
      const print = () => console.log(JSON.stringify(existsSync(pathsFor(runDirectory).progressPath)
        ? readJson(pathsFor(runDirectory).progressPath) : runtime.linearTrainingProgress(readJson(runPath)), null, 2))
      print()
      if (args.watch) setInterval(print, PROGRESS_INTERVAL_MS)
      return
    }
    if (args.command === 'pause') {
      if (run.status !== 'running' || !run.activeGeneration) throw new Error('There is no running generation to pause')
      const request = {
        kind: 'rvb-linear-pause-request-v1', runId: run.runId,
        generation: run.activeGeneration.generation, requestedAt: new Date().toISOString(),
      }
      writeJsonAtomically(join(runDirectory, 'pause-request.json'), request)
      appendEvent(runDirectory, { kind: 'pause-requested', generation: run.activeGeneration.generation })
      console.log(JSON.stringify({ status: 'pause-requested', ...request }, null, 2))
      return
    }
    runtime.assertLinearRunCompatibility(run, {
      ...sourceHashes(), featureSchemaHash: runtime.AI_LINEAR_FEATURE_SCHEMA_HASH,
      trainingConfigHash: trainingConfigHash(configPath, config),
    })
    const shouldSync = args.githubSync ?? config.github.enabled
    if (args.command === 'sync') {
      const sync = syncGitHub(runtime, config, run, `sync ${run.runId} generation ${run.completedGeneration}`)
      run = { ...run, githubSync: sync }
      writeJsonAtomically(runPath, run)
      writeProgress(runtime, runDirectory, run, [], sync)
      console.log(JSON.stringify(sync, null, 2))
      return
    }
    if (run.githubSync?.status === 'pending' && args.command === 'next') {
      throw new Error('Previous generation GitHub sync is pending; run sync before next')
    }
    if (args.command === 'next') {
      const seedPartitions = readJson(fromRoot(config.seedFile))
      const selected = selectGenerationInputs(config, run.completedGeneration + 1, seedPartitions)
      run = runtime.beginLinearGeneration(run, {
        rootSeeds: selected.rootSeeds,
        lineupId: selected.lineup.lineupId,
        opponentAgentIds: selected.opponentFiles.map(path => readJson(fromRoot(path)).agentId),
        pairCount: config.pairCount,
        sigma: config.sigma,
      })
      writeJsonAtomically(runPath, run)
      appendEvent(runDirectory, { kind: 'generation-started', generation: run.activeGeneration.generation })
    } else if (args.command === 'resume') {
      if (run.status === 'paused') run = runtime.resumeLinearGeneration(run)
      else if (run.status !== 'running') throw new Error('There is no paused or interrupted generation to resume')
      writeJsonAtomically(runPath, run)
      appendEvent(runDirectory, { kind: 'generation-resumed', generation: run.activeGeneration.generation })
    }
    const processCount = Math.min(args.processes ?? config.processCount, 3)
    const result = await runGeneration(runtime, config, runDirectory, run, processCount, args.verbose)
    run = result.run
    let sync = { status: 'not-requested' }
    if (shouldSync) {
      try {
        sync = syncGitHub(runtime, config, run, result.paused
          ? `checkpoint ${run.runId} generation ${run.activeGeneration.generation}`
          : `archive ${run.runId} generation ${run.completedGeneration}`)
      } catch (error) {
        sync = { status: 'pending', error: String(error?.message ?? error), at: new Date().toISOString() }
      }
      run = { ...run, githubSync: sync }
      writeJsonAtomically(runPath, run)
    }
    const progress = writeProgress(runtime, runDirectory, run, [], sync)
    displayProgress(progress, Date.now())
    console.log(JSON.stringify({
      status: run.status,
      completedGeneration: run.completedGeneration,
      activeGeneration: run.activeGeneration?.generation,
      githubSync: sync,
      nextRequiresUser: run.status === 'awaiting-user',
      runDirectory,
    }, null, 2))
  } finally {
    cleanup()
  }
}

const workerIndex = process.argv.indexOf(INTERNAL_WORKER)
const entry = workerIndex >= 0
  ? workerMain(process.argv[workerIndex + 1], process.argv[workerIndex + 2])
  : main()
entry.catch(error => {
  console.error(`[ai:train:linear] ${error?.stack || error}`)
  process.exitCode = 1
})
