import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'

import { build } from 'esbuild'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const root = resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const REPLAY_ONLY_GAME_FILES = new Set([
  'lib/game/ai-self-play-replay.ts',
])
const LEGACY_RUNNER_BLOB = '2fc86e75346ee0b22a28077e87ea4436b975d9a7'
const LEGACY_SETUP_HASH = '066766367a8c0e60574b1114e6d3f898daba2aabbed12a39f20a580c98985168'

function usage() {
  console.log(`Usage:
  npm run ai:self-play:export -- <report.json> --list
  npm run ai:self-play:export -- <report.json> --match <index|matchId> --output <trace.json>

Options:
  --list                    List the report matches as JSON
  --match <index|matchId>   Select one match by 1-based index or exact matchId
  --output <path>           Write one rvb-match-trace/v2 file; never overwrites
  --help                    Show this help
`)
}

function parseArgs(argv) {
  const result = { list: false }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--help') result.help = true
    else if (value === '--list') result.list = true
    else if (value === '--match' || value === '--output') {
      const next = argv[++index]
      if (!next) throw new Error(`${value} requires a value`)
      result[value.slice(2)] = next
    } else if (value.startsWith('--')) throw new Error(`Unknown argument ${value}`)
    else positional.push(value)
  }
  if (result.help) return result
  if (positional.length !== 1) throw new Error('Exactly one self-play report JSON path is required')
  result.report = positional[0]
  if (result.list && (result.match || result.output)) {
    throw new Error('--list cannot be combined with --match or --output')
  }
  if (!result.list && (!result.match || !result.output)) {
    throw new Error('Export requires both --match and --output')
  }
  return result
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
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

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

function assertAuthoritativeCodeCompatible(reportCommit) {
  if (typeof reportCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(reportCommit)) {
    throw new Error('Self-play report codeCommit is not a full Git commit hash')
  }
  const commit = git(['cat-file', '-e', `${reportCommit}^{commit}`])
  if (commit.status !== 0) {
    throw new Error('Self-play report codeCommit is unavailable in this repository')
  }

  const reportHasSharedSetup = git([
    'cat-file', '-e', `${reportCommit}:lib/game/ai-self-play-setup.ts`,
  ]).status === 0
  if (!reportHasSharedSetup) {
    const legacyRunner = git(['rev-parse', `${reportCommit}:scripts/ai/run-self-play.mjs`])
    if (legacyRunner.status !== 0 || legacyRunner.stdout.trim() !== LEGACY_RUNNER_BLOB) {
      throw new Error('Legacy self-play setup is incompatible with the authoritative replay runtime')
    }
    const normalizedSetup = readFileSync(
      resolve(root, 'lib/game/ai-self-play-setup.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n')
    const setupHash = createHash('sha256').update(normalizedSetup).digest('hex')
    if (setupHash !== LEGACY_SETUP_HASH) {
      throw new Error('Extracted legacy self-play setup has changed and cannot replay this report safely')
    }
  }

  const comparisonArgs = [
    'diff', '--quiet', reportCommit, '--', 'lib/game',
    ':(exclude)lib/game/ai-self-play-replay.ts',
  ]
  if (!reportHasSharedSetup) {
    comparisonArgs.push(':(exclude)lib/game/ai-self-play-setup.ts')
  }
  const comparison = git(comparisonArgs)
  if (comparison.status !== 0) {
    throw new Error('Self-play report codeCommit is incompatible with the current authoritative game runtime')
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'lib/game'])
  if (untracked.status !== 0) throw new Error('Unable to inspect untracked authoritative game files')
  const unsafeUntracked = untracked.stdout.split(/\r?\n/).filter(Boolean)
    .filter(path => !REPLAY_ONLY_GAME_FILES.has(path.replaceAll('\\', '/')))
  if (unsafeUntracked.length) {
    throw new Error('Untracked authoritative game code makes codeCommit compatibility unverifiable')
  }
}

function currentCompatibility(report) {
  assertAuthoritativeCodeCompatible(report.codeCommit)
  return {
    schemaVersion: 1,
    codeCommit: report.codeCommit,
    rulesHash: hashTrees([resolve(root, 'data/rules')]),
    contentHash: hashTrees([
      resolve(root, 'data/cards'), resolve(root, 'data/maps'),
      resolve(root, 'data/pieces'), resolve(root, 'data/skills'),
    ]),
  }
}

async function buildRuntime() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-ai-self-play-replay-'))
  const outfile = join(temporaryDirectory, 'runtime.cjs')
  const replayPath = JSON.stringify(resolve(root, 'lib/game/ai-self-play-replay.ts'))
  const setupPath = JSON.stringify(resolve(root, 'lib/game/ai-self-play-setup.ts'))
  const source = `
    import {
      createSelfPlayTraceSource, listSelfPlayMatches, replayRecordedSelfPlayMatch,
    } from ${replayPath}
    import { createSelfPlayInitialState } from ${setupPath}

    export function list(report: any) {
      return listSelfPlayMatches(report)
    }

    export async function replay(payload: any) {
      const result = await replayRecordedSelfPlayMatch(payload.report, payload.selector, {
        compatibility: payload.compatibility,
        createInitialState: createSelfPlayInitialState,
      })
      return {
        finalState: result.finalState,
        match: result.match,
        source: createSelfPlayTraceSource(payload.report, result.match),
        initialStateHash: result.initialStateHash,
        finalStateHash: result.finalStateHash,
        actionsApplied: result.actionsApplied,
      }
    }
  `
  await build({
    absWorkingDir: root,
    stdin: { contents: source, loader: 'ts', resolveDir: root, sourcefile: 'self-play-replay-runtime.ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent',
  })
  const originalLog = console.log
  try {
    console.log = () => {}
    return {
      runtime: require(outfile),
      cleanup: () => rmSync(temporaryDirectory, { recursive: true, force: true }),
    }
  } finally {
    console.log = originalLog
  }
}

function loadTraceTools() {
  const source = readFileSync(resolve(root, 'data/pages/js/developer-tools/match-trace.js'), 'utf8')
  const context = createContext({ window: {} })
  new Script(source, { filename: 'match-trace.js' }).runInContext(context)
  return context.window.RvBDeveloperTools
}

export function writeTraceFileExclusive(outputPath, serialized) {
  mkdirSync(dirname(outputPath), { recursive: true })
  let descriptor
  let created = false
  try {
    descriptor = openSync(outputPath, 'wx')
    created = true
    writeFileSync(descriptor, serialized, 'utf8')
    fsyncSync(descriptor)
  } catch (error) {
    if (created) {
      try { unlinkSync(outputPath) } catch { /* Preserve the original write error. */ }
    }
    if (error?.code === 'EEXIST') throw new Error(`Output already exists; refusing to overwrite: ${outputPath}`)
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

async function main() {
  const invocationDirectory = process.cwd()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  const reportPath = resolve(invocationDirectory, args.report)
  const report = readJson(reportPath)
  process.chdir(root)
  const { runtime, cleanup } = await buildRuntime()
  try {
    if (args.list) {
      console.log(JSON.stringify(runtime.list(report), null, 2))
      return
    }

    const outputPath = resolve(invocationDirectory, args.output)
    if (existsSync(outputPath)) throw new Error(`Output already exists; refusing to overwrite: ${outputPath}`)
    const compatibility = currentCompatibility(report)
    const originalLog = console.log
    let replay
    try {
      console.log = () => {}
      replay = await runtime.replay({ report, selector: args.match, compatibility })
    } finally {
      console.log = originalLog
    }
    const tools = loadTraceTools()
    const trace = tools.createTraceRecord({
      state: replay.finalState,
      roomId: `ai-${replay.match.matchId}`,
      seed: replay.match.rootSeed,
      authorityVersion: replay.finalState._v,
      source: replay.source,
    })
    if (trace.frames.length !== replay.actionsApplied) {
      throw new Error('Trace v2 frame count does not match the recorded self-play action count')
    }
    if (trace.final.stateHash !== replay.finalStateHash) {
      throw new Error('Trace v2 final state hash does not match the self-play report')
    }
    const serialized = `${tools.serializeTrace(tools.assertTraceRecord(trace))}\n`
    writeTraceFileExclusive(outputPath, serialized)
    console.log(JSON.stringify({
      format: trace.format,
      matchId: replay.match.matchId,
      actions: replay.actionsApplied,
      initialStateHash: replay.initialStateHash,
      finalStateHash: replay.finalStateHash,
      outputPath,
    }, null, 2))
  } finally {
    cleanup()
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === scriptPath
if (isMain) {
  main().catch(error => {
    console.error(`[ai:self-play:export] ${error?.stack || error}`)
    process.exitCode = 1
  })
}
