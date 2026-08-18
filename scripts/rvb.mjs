#!/usr/bin/env node

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.RVB_REPO_ROOT
  ? path.resolve(process.env.RVB_REPO_ROOT)
  : path.resolve(SCRIPT_DIR, '..')
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'validation-profiles.json')
const DEFAULT_OUTPUT_ROOT = path.join(REPO_ROOT, 'output', 'validation')
const TASK_ID_PATTERN = /^RED-\d+$/i

const USAGE = `RVB project workflow

Usage:
  npm run rvb -- dev
  npm run rvb -- doctor
  npm run rvb -- verify RED-123 [--profile quick|standard|candidate] [--dry-run]
  npm run rvb -- package RED-123 [--dry-run]
`

function usageError(message) {
  console.error(`[RVB] ${message}\n`)
  console.error(USAGE)
  return { kind: 'error', exitCode: 2 }
}

function normalizeTaskId(value) {
  if (!value || !TASK_ID_PATTERN.test(value)) return null
  return value.toUpperCase()
}

function parseArgs(argv) {
  const [command, ...rest] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'help' }
  }

  if (command === 'dev' || command === 'doctor') {
    if (rest.length) return usageError(`${command} does not accept additional arguments.`)
    return { kind: command }
  }

  if (command !== 'verify' && command !== 'package') {
    return usageError(`Unknown command: ${command}`)
  }

  const taskId = normalizeTaskId(rest[0])
  if (!taskId) return usageError('Task ID must use the RED-<number> format.')

  let dryRun = false
  let profile = command === 'verify' ? 'standard' : 'package'

  for (let index = 1; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--dry-run') {
      dryRun = true
      continue
    }
    if (value === '--profile' && command === 'verify') {
      const selected = rest[index + 1]
      if (!selected || selected.startsWith('--')) {
        return usageError('--profile requires a value.')
      }
      profile = selected
      index += 1
      continue
    }
    return usageError(`Unknown argument: ${value}`)
  }

  return { kind: command, taskId, profile, dryRun }
}

function loadConfig() {
  const configured = process.env.RVB_CONFIG_PATH
  const configPath = configured ? path.resolve(configured) : DEFAULT_CONFIG_PATH
  let config

  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read validation config at ${configPath}: ${error.message}`)
  }

  if (config?.version !== 1) throw new Error('Validation config version must be 1.')
  if (!config.entrypoints || !config.commands || !config.profiles) {
    throw new Error('Validation config requires entrypoints, commands, and profiles.')
  }

  for (const [key, command] of Object.entries(config.commands)) {
    if (
      !command ||
      typeof command.label !== 'string' ||
      typeof command.executable !== 'string' ||
      !Array.isArray(command.args) ||
      command.args.some((arg) => typeof arg !== 'string')
    ) {
      throw new Error(`Invalid command configuration: ${key}`)
    }
  }

  for (const [profile, steps] of Object.entries(config.profiles)) {
    if (!Array.isArray(steps) || steps.some((step) => !config.commands[step])) {
      throw new Error(`Invalid validation profile: ${profile}`)
    }
  }

  for (const entrypoint of ['dev', 'package']) {
    if (!config.commands[config.entrypoints[entrypoint]]) {
      throw new Error(`Invalid ${entrypoint} entrypoint.`)
    }
  }

  return { config, configPath }
}

function spawnDescriptor(executable, args) {
  if (executable === 'npm') {
    const npmExecPath = process.env.npm_execpath
    if (npmExecPath && existsSync(npmExecPath)) {
      return {
        executable: process.execPath,
        args: [npmExecPath, ...args],
        shell: false,
      }
    }
    if (process.platform === 'win32') {
      return { executable: 'npm', args, shell: true }
    }
  }
  return { executable, args, shell: false }
}

function quoteArgument(value) {
  if (/^[A-Za-z0-9_./:@\\-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function displayCommand(command) {
  return [command.executable, ...command.args].map(quoteArgument).join(' ')
}

function capture(executable, args) {
  const descriptor = spawnDescriptor(executable, args)
  const result = spawnSync(descriptor.executable, descriptor.args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: descriptor.shell,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trimEnd(),
    stderr: (result.stderr || '').trimEnd(),
    error: result.error?.message,
  }
}

function collectContext() {
  const commit = capture('git', ['rev-parse', '--short', 'HEAD'])
  const branch = capture('git', ['branch', '--show-current'])
  const status = capture('git', ['status', '--porcelain'])
  const npm = capture('npm', ['--version'])
  const dirtyFiles = status.ok && status.stdout ? status.stdout.split(/\r?\n/) : []

  return {
    commit: commit.ok ? commit.stdout : 'unknown',
    branch: branch.ok && branch.stdout ? branch.stdout : 'unknown',
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    node: process.version,
    npm: npm.ok ? npm.stdout : 'unknown',
    platform: process.platform,
    arch: process.arch,
  }
}

function runDoctor(configPath) {
  const checks = []
  const npm = capture('npm', ['--version'])
  const git = capture('git', ['rev-parse', '--is-inside-work-tree'])
  const branch = capture('git', ['branch', '--show-current'])
  const status = capture('git', ['status', '--porcelain'])

  checks.push({ label: `Node ${process.version}`, ok: true })
  checks.push({ label: npm.ok ? `npm ${npm.stdout}` : `npm unavailable: ${npm.error || npm.stderr}`, ok: npm.ok })
  checks.push({ label: `Config ${path.relative(REPO_ROOT, configPath) || configPath}`, ok: existsSync(configPath) })
  checks.push({ label: 'package.json', ok: existsSync(path.join(REPO_ROOT, 'package.json')) })
  checks.push({ label: 'package-lock.json', ok: existsSync(path.join(REPO_ROOT, 'package-lock.json')) })
  checks.push({
    label: 'Next.js dependency installed',
    ok: existsSync(path.join(REPO_ROOT, 'node_modules', 'next', 'package.json')),
  })
  checks.push({
    label: git.ok ? `Git repository on ${branch.stdout || 'detached HEAD'}` : `Git unavailable: ${git.error || git.stderr}`,
    ok: git.ok,
  })

  console.log('[RVB doctor]')
  for (const check of checks) console.log(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.label}`)

  if (status.ok && status.stdout) {
    console.log(`[WARN] Worktree has ${status.stdout.split(/\r?\n/).length} changed path(s).`)
  } else if (status.ok) {
    console.log('[PASS] Worktree is clean.')
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`Doctor: ${failed.length ? 'FAIL' : 'PASS'}`)
  return failed.length ? 1 : 0
}

function runInherited(command) {
  const descriptor = spawnDescriptor(command.executable, command.args)
  return new Promise((resolve) => {
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
      shell: descriptor.shell,
    })
    child.once('error', (error) => {
      console.error(`[RVB] Failed to start ${displayCommand(command)}: ${error.message}`)
      resolve(1)
    })
    child.once('close', (code) => resolve(typeof code === 'number' ? code : 1))
  })
}

function runLogged(command, logPath) {
  const descriptor = spawnDescriptor(command.executable, command.args)
  return new Promise((resolve) => {
    const startedAt = new Date()
    const started = startedAt.getTime()
    const log = createWriteStream(logPath, { encoding: 'utf8' })
    log.write(`$ ${displayCommand(command)}\n`)

    let spawnError = null
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: descriptor.shell,
    })

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      log.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      log.write(chunk)
    })
    child.once('error', (error) => {
      spawnError = error
      const line = `\n[RVB] Spawn error: ${error.message}\n`
      process.stderr.write(line)
      log.write(line)
    })
    child.once('close', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : 1
      const finishedAt = new Date()
      log.write(`\n[RVB] Exit code: ${exitCode}${signal ? `; signal: ${signal}` : ''}\n`)
      log.end(() => {
        resolve({
          exitCode,
          signal: signal || null,
          error: spawnError?.message || null,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - started,
        })
      })
    })
  })
}

function safeStepName(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, '-')
}

function createRunDirectory(outputRoot, taskId, context) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '')
  const runId = `${timestamp}-${safeStepName(context.commit)}-${process.pid}`
  const runDir = path.join(outputRoot, taskId, runId)
  mkdirSync(runDir, { recursive: true })
  return { runDir, runId }
}

function tableCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderReport(manifest) {
  const lines = [
    '# RVB validation report',
    '',
    `- Status: **${manifest.status}**`,
    `- Task: ${manifest.taskId}`,
    `- Mode: ${manifest.mode}`,
    `- Profile: ${manifest.profile}`,
    `- Git commit: ${manifest.repository.commit}`,
    `- Branch: ${manifest.repository.branch}`,
    `- Worktree: ${manifest.repository.dirty ? `DIRTY (${manifest.repository.dirtyFiles.length} changed path(s))` : 'clean'}`,
    `- Node/npm: ${manifest.runtime.node} / ${manifest.runtime.npm}`,
    `- Platform: ${manifest.runtime.platform} ${manifest.runtime.arch}`,
    `- Started: ${manifest.startedAt}`,
    `- Finished: ${manifest.finishedAt}`,
    `- Duration: ${manifest.durationMs} ms`,
    '',
    '## Steps',
    '',
    '| # | Step | Status | Exit | Started | Finished | Duration | Command | Log |',
    '| ---: | --- | --- | ---: | --- | --- | ---: | --- | --- |',
  ]

  manifest.steps.forEach((step, index) => {
    const log = step.log ? `[${step.log}](${step.log})` : '-'
    lines.push(
      `| ${index + 1} | ${tableCell(step.label)} | ${step.status} | ${step.exitCode ?? '-'} | ${step.startedAt ?? '-'} | ${step.finishedAt ?? '-'} | ${step.durationMs} ms | \`${tableCell(step.command)}\` | ${log} |`,
    )
  })

  lines.push('', '## Worktree snapshot', '')
  if (manifest.repository.dirtyFiles.length) {
    lines.push('```text', ...manifest.repository.dirtyFiles, '```')
  } else {
    lines.push('Clean when evidence collection started.')
  }

  lines.push(
    '',
    '## Human verification',
    '',
    'This report records command execution only. Product experience, screenshots, and any task-specific manual acceptance criteria still require human verification.',
    '',
  )
  return lines.join('\n')
}

function writeEvidence(runDir, manifest) {
  writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(runDir, 'report.md'), renderReport(manifest), 'utf8')
}

async function runEvidenceMode(parsed, config) {
  let stepKeys
  if (parsed.kind === 'package') {
    stepKeys = [config.entrypoints.package]
  } else {
    stepKeys = config.profiles[parsed.profile]
    if (!stepKeys) {
      const error = usageError(`Unknown profile: ${parsed.profile}. Available profiles: ${Object.keys(config.profiles).join(', ')}`)
      return error.exitCode
    }
  }

  const context = collectContext()
  const outputRoot = process.env.RVB_OUTPUT_DIR
    ? path.resolve(process.env.RVB_OUTPUT_DIR)
    : DEFAULT_OUTPUT_ROOT
  const { runDir, runId } = createRunDirectory(outputRoot, parsed.taskId, context)
  const startedAt = new Date()
  const manifest = {
    schemaVersion: 1,
    runId,
    taskId: parsed.taskId,
    mode: parsed.kind,
    profile: parsed.profile,
    status: parsed.dryRun ? 'DRY-RUN' : 'RUNNING',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    repository: {
      commit: context.commit,
      branch: context.branch,
      dirty: context.dirty,
      dirtyFiles: context.dirtyFiles,
    },
    runtime: {
      node: context.node,
      npm: context.npm,
      platform: context.platform,
      arch: context.arch,
    },
    steps: [],
  }

  let failureCode = 0
  if (!parsed.dryRun) mkdirSync(path.join(runDir, 'logs'), { recursive: true })

  for (let index = 0; index < stepKeys.length; index += 1) {
    const key = stepKeys[index]
    const command = config.commands[key]
    const shown = displayCommand(command)

    if (parsed.dryRun) {
      console.log(`[DRY-RUN] ${command.label}: ${shown}`)
      manifest.steps.push({
        key,
        label: command.label,
        command: shown,
        status: 'DRY-RUN',
        exitCode: null,
        signal: null,
        error: null,
        durationMs: 0,
        startedAt: null,
        finishedAt: null,
        log: null,
      })
      continue
    }

    const logRelative = `logs/${String(index + 1).padStart(2, '0')}-${safeStepName(key)}.log`
    console.log(`\n[RVB] ${index + 1}/${stepKeys.length} ${command.label}`)
    console.log(`[RVB] $ ${shown}`)
    const result = await runLogged(command, path.join(runDir, ...logRelative.split('/')))
    const status = result.exitCode === 0 ? 'PASS' : 'FAIL'
    manifest.steps.push({
      key,
      label: command.label,
      command: shown,
      status,
      ...result,
      log: logRelative,
    })

    if (result.exitCode !== 0) {
      failureCode = result.exitCode
      break
    }
  }

  manifest.status = parsed.dryRun ? 'DRY-RUN' : failureCode ? 'FAIL' : 'PASS'
  manifest.finishedAt = new Date().toISOString()
  manifest.durationMs = Date.now() - startedAt.getTime()
  writeEvidence(runDir, manifest)

  console.log(`\n[RVB] ${manifest.status}`)
  console.log(`[RVB] Evidence: ${path.join(runDir, 'report.md')}`)
  return failureCode
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.kind === 'help') {
    console.log(USAGE)
    return 0
  }
  if (parsed.kind === 'error') return parsed.exitCode

  let loaded
  try {
    loaded = loadConfig()
  } catch (error) {
    console.error(`[RVB] ${error.message}`)
    return 1
  }

  if (parsed.kind === 'doctor') return runDoctor(loaded.configPath)
  if (parsed.kind === 'dev') {
    return runInherited(loaded.config.commands[loaded.config.entrypoints.dev])
  }
  return runEvidenceMode(parsed, loaded.config)
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    console.error(`[RVB] Unexpected error: ${error.stack || error.message}`)
    process.exitCode = 1
  })
