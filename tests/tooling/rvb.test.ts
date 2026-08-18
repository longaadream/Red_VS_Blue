import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(__dirname, '../..')
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'rvb.mjs')
const tempDirs: string[] = []

interface TestCommand {
  label: string
  executable: string
  args: string[]
}

interface TestConfig {
  version: number
  entrypoints: {
    dev: string
    package: string
  }
  commands: Record<string, TestCommand>
  profiles: Record<string, string[]>
}

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'rvb-cli-'))
  tempDirs.push(workspace)
  return {
    workspace,
    configPath: path.join(workspace, 'validation-profiles.json'),
    outputRoot: path.join(workspace, 'validation-output'),
  }
}

function baseConfig(overrides: Partial<TestConfig> = {}): TestConfig {
  const noop: TestCommand = {
    label: 'No-op',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  }

  return {
    version: 1,
    entrypoints: { dev: 'dev', package: 'package' },
    commands: { dev: noop, package: noop },
    profiles: { quick: [] },
    ...overrides,
  }
}

function runCli(
  args: string[],
  config: TestConfig,
  paths: ReturnType<typeof makeWorkspace>,
  environment: Record<string, string> = {},
) {
  writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      RVB_CONFIG_PATH: paths.configPath,
      RVB_OUTPUT_DIR: paths.outputRoot,
      ...environment,
    },
  })
}

function readOnlyRun(paths: ReturnType<typeof makeWorkspace>, taskId = 'RED-93') {
  const taskRoot = path.join(paths.outputRoot, taskId)
  const runs = readdirSync(taskRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(taskRoot, entry.name))
  expect(runs).toHaveLength(1)
  return runs[0]
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('rvb CLI', { timeout: 30_000 }, () => {
  it('rejects invalid task IDs and profiles without creating a report', () => {
    const paths = makeWorkspace()
    const config = baseConfig()

    const badTask = runCli(['verify', 'task-93', '--dry-run'], config, paths)
    expect(badTask.status).not.toBe(0)
    expect(`${badTask.stdout}${badTask.stderr}`).toContain('RED-<number>')
    expect(existsSync(paths.outputRoot)).toBe(false)

    const badProfile = runCli(
      ['verify', 'RED-93', '--profile', 'missing', '--dry-run'],
      config,
      paths,
    )
    expect(badProfile.status).not.toBe(0)
    expect(`${badProfile.stdout}${badProfile.stderr}`).toContain('Unknown profile')
    expect(`${badProfile.stdout}${badProfile.stderr}`).toContain('Usage:')
    expect(existsSync(paths.outputRoot)).toBe(false)

    const badCommand = runCli(['unknown-command'], config, paths)
    expect(badCommand.status).not.toBe(0)
    expect(`${badCommand.stdout}${badCommand.stderr}`).toContain('Unknown command')
    expect(existsSync(paths.outputRoot)).toBe(false)
  })

  it('rejects an incomplete node_modules directory during doctor checks', () => {
    const paths = makeWorkspace()
    const config = baseConfig()
    writeFileSync(path.join(paths.workspace, 'package.json'), '{}\n', 'utf8')
    writeFileSync(path.join(paths.workspace, 'package-lock.json'), '{}\n', 'utf8')
    mkdirSync(path.join(paths.workspace, 'node_modules'))

    const result = runCli(['doctor'], config, paths, {
      RVB_REPO_ROOT: paths.workspace,
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(
      '[FAIL] Next.js dependency installed',
    )
  })

  it('delegates dev to its configured existing entrypoint', () => {
    const paths = makeWorkspace()
    const marker = path.join(paths.workspace, 'dev-ran.txt')
    const config = baseConfig({
      commands: {
        dev: {
          label: 'Configured dev',
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        },
        package: baseConfig().commands.package,
      },
    })

    const result = runCli(['dev'], config, paths)

    expect(result.status).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('ran')
    expect(existsSync(paths.outputRoot)).toBe(false)
  })

  it('creates a DRY-RUN report without executing configured commands', () => {
    const paths = makeWorkspace()
    const marker = path.join(paths.workspace, 'should-not-exist.txt')
    const config = baseConfig({
      commands: {
        dev: baseConfig().commands.dev,
        package: baseConfig().commands.package,
        marker: {
          label: 'Create marker',
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        },
      },
      profiles: { quick: ['marker'] },
    })

    const result = runCli(
      ['verify', 'RED-93', '--profile', 'quick', '--dry-run'],
      config,
      paths,
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY-RUN')
    expect(result.stdout).toContain('Create marker')
    expect(existsSync(marker)).toBe(false)

    const runDir = readOnlyRun(paths)
    const report = readFileSync(path.join(runDir, 'report.md'), 'utf8')
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
    expect(report).toContain('**DRY-RUN**')
    expect(manifest.status).toBe('DRY-RUN')
    expect(manifest.steps[0].status).toBe('DRY-RUN')
    expect(manifest.steps[0].startedAt).toBeNull()
    expect(manifest.steps[0].finishedAt).toBeNull()
  })

  it('writes PASS evidence for a successful verification', () => {
    const paths = makeWorkspace()
    const config = baseConfig({
      commands: {
        dev: baseConfig().commands.dev,
        package: baseConfig().commands.package,
        pass: {
          label: 'Passing check',
          executable: process.execPath,
          args: ['-e', "console.log('hello-from-pass')"],
        },
      },
      profiles: { quick: ['pass'] },
    })

    const result = runCli(['verify', 'RED-93', '--profile', 'quick'], config, paths)

    expect(result.status).toBe(0)
    const runDir = readOnlyRun(paths)
    const report = readFileSync(path.join(runDir, 'report.md'), 'utf8')
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
    const log = readFileSync(path.join(runDir, manifest.steps[0].log), 'utf8')
    expect(report).toContain('**PASS**')
    expect(report).toContain('Passing check')
    expect(manifest.status).toBe('PASS')
    expect(manifest.steps[0].exitCode).toBe(0)
    expect(log).toContain('hello-from-pass')
    expect(manifest.steps[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(manifest.steps[0].finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Date.parse(manifest.steps[0].finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(manifest.steps[0].startedAt),
    )
    expect(report).toContain(manifest.steps[0].startedAt)
  })

  it('stops after the first failure and still writes failure evidence', () => {
    const paths = makeWorkspace()
    const marker = path.join(paths.workspace, 'after-failure.txt')
    const config = baseConfig({
      commands: {
        dev: baseConfig().commands.dev,
        package: baseConfig().commands.package,
        fail: {
          label: 'Expected failure',
          executable: process.execPath,
          args: ['-e', "console.error('expected-failure'); process.exit(7)"],
        },
        after: {
          label: 'Must not run',
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        },
      },
      profiles: { quick: ['fail', 'after'] },
    })

    const result = runCli(['verify', 'RED-93', '--profile', 'quick'], config, paths)

    expect(result.status).toBe(7)
    expect(existsSync(marker)).toBe(false)
    const runDir = readOnlyRun(paths)
    const report = readFileSync(path.join(runDir, 'report.md'), 'utf8')
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
    expect(report).toContain('**FAIL**')
    expect(report).toContain('Expected failure')
    expect(manifest.status).toBe('FAIL')
    expect(manifest.steps).toHaveLength(1)
    expect(manifest.steps[0].exitCode).toBe(7)
  })

  it('executes npm-backed checks on the current platform', () => {
    const paths = makeWorkspace()
    const config = baseConfig({
      commands: {
        dev: baseConfig().commands.dev,
        package: baseConfig().commands.package,
        npmVersion: {
          label: 'npm version',
          executable: 'npm',
          args: ['--version'],
        },
      },
      profiles: { quick: ['npmVersion'] },
    })

    const result = runCli(['verify', 'RED-93', '--profile', 'quick'], config, paths)

    expect(result.status).toBe(0)
    const runDir = readOnlyRun(paths)
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
    const log = readFileSync(path.join(runDir, manifest.steps[0].log), 'utf8')
    expect(manifest.status).toBe('PASS')
    expect(manifest.steps[0].exitCode).toBe(0)
    expect(log).toMatch(/\d+\.\d+\.\d+/)
  })

  it('shows the existing Electron package command in package dry-run evidence', () => {
    const paths = makeWorkspace()
    const config = baseConfig({
      commands: {
        dev: baseConfig().commands.dev,
        package: {
          label: 'Electron client package',
          executable: 'npm',
          args: ['run', 'build:electron:client'],
        },
      },
    })

    const result = runCli(['package', 'RED-93', '--dry-run'], config, paths)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('npm run build:electron:client')
    const runDir = readOnlyRun(paths)
    const report = readFileSync(path.join(runDir, 'report.md'), 'utf8')
    expect(report).toContain('Electron client package')
    expect(report).toContain('npm run build:electron:client')
  })
})
