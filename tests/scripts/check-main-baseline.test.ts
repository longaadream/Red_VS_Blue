import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const sourceScript = path.resolve('scripts/check-main-baseline.mjs')
const temporaryRoots: string[] = []

type Fixture = {
  bare: string
  parent: string
  root: string
  seed: string
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function configureIdentity(root: string) {
  git(root, ['config', 'user.name', 'RED-92 Fixture'])
  git(root, ['config', 'user.email', 'red-92@example.invalid'])
}

function writeFile(root: string, relative: string, content: string) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function commitAll(root: string, message: string) {
  git(root, ['add', '.'])
  git(root, ['commit', '-m', message])
}

function createFixture(branchName = 'codex/RED-92-fixture'): Fixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb main baseline '))
  temporaryRoots.push(parent)
  const bare = path.join(parent, 'origin repository.git')
  const seed = path.join(parent, 'seed repository')
  const checkout = path.join(parent, 'checkout repository')
  const root = path.join(parent, 'issue worktree with spaces')

  fs.mkdirSync(seed, { recursive: true })
  git(parent, ['init', '--bare', bare])
  git(seed, ['init', '-b', 'main'])
  configureIdentity(seed)
  writeFile(seed, 'README.md', 'main baseline\n')
  commitAll(seed, 'initial main')
  git(seed, ['remote', 'add', 'origin', bare])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

  git(parent, ['clone', '--branch', 'main', bare, checkout])
  configureIdentity(checkout)
  git(checkout, ['worktree', 'add', '-b', branchName, root, 'main'])
  writeFile(root, 'scripts/check-main-baseline.mjs', fs.readFileSync(sourceScript, 'utf8'))
  commitAll(root, 'add baseline fixture script')

  return { bare, parent, root, seed }
}

function advanceMain(fixture: Fixture, content = `main update ${Date.now()}\n`) {
  writeFile(fixture.seed, 'README.md', content)
  commitAll(fixture.seed, 'advance main')
  git(fixture.seed, ['push', 'origin', 'main'])
}

function replaceMainWithUnrelatedHistory(fixture: Fixture) {
  const rewrite = path.join(fixture.parent, 'unrelated main')
  fs.mkdirSync(rewrite, { recursive: true })
  git(rewrite, ['init', '-b', 'main'])
  configureIdentity(rewrite)
  writeFile(rewrite, 'UNRELATED.md', 'unrelated main history\n')
  commitAll(rewrite, 'replace main history')
  git(rewrite, ['remote', 'add', 'origin', fixture.bare])
  git(rewrite, ['push', '--force', 'origin', 'main'])
}

function resolveGitPath(root: string, gitRelativePath: string) {
  const candidate = git(root, ['rev-parse', '--git-path', gitRelativePath])
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
}

function runCheck(root: string, options: { args?: string[]; env?: Record<string, string | undefined> } = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts/check-main-baseline.mjs'), ...(options.args ?? [])],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...(options.env ?? {}),
      },
    },
  )
}

function fingerprintWorkingTree(root: string): string {
  const entries: string[] = []
  function visit(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute)
      if (entry.isDirectory()) {
        entries.push(`directory:${relative}`)
        visit(absolute)
      } else {
        entries.push(`file:${relative}:${fs.readFileSync(absolute).toString('base64')}`)
      }
    }
  }
  visit(root)
  return entries.join('\n')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('origin/main baseline check', { timeout: 60_000 }, () => {
  it('passes an up-to-date RED branch and does not modify its working tree', () => {
    const fixture = createFixture()
    const before = fingerprintWorkingTree(fixture.root)

    const result = runCheck(fixture.root)

    expect(fs.lstatSync(path.join(fixture.root, '.git')).isFile()).toBe(true)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[main-baseline] OK')
    expect(result.stdout).toContain(`Repository: ${fs.realpathSync.native(fixture.root)}`)
    expect(result.stdout).toContain('Branch: codex/RED-92-fixture')
    expect(result.stdout).toMatch(/HEAD: [0-9a-f]{40}/)
    expect(result.stdout).toMatch(/Base \(origin\/main\): [0-9a-f]{40}/)
    expect(result.stdout).toContain('Ahead: 1')
    expect(result.stdout).toContain('Behind: 0')
    expect(fingerprintWorkingTree(fixture.root)).toBe(before)
    expect(git(fixture.root, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
  })

  it('fails closed when the branch is behind a newly fetched main', () => {
    const fixture = createFixture()
    advanceMain(fixture)

    const result = runCheck(fixture.root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[main-baseline] FAILED code=BEHIND_MAIN')
    expect(result.stderr).toContain('Ahead: 1')
    expect(result.stderr).toContain('Behind: 1')
    expect(result.stderr).toContain('git fetch origin')
    expect(result.stderr).toContain('git rebase origin/main')
    expect(result.stderr).toContain('Shared branches must choose merge explicitly')
  })

  it('distinguishes a missing origin remote', () => {
    const fixture = createFixture()
    git(fixture.root, ['remote', 'remove', 'origin'])

    const result = runCheck(fixture.root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[main-baseline] FAILED code=MISSING_REMOTE')
  })

  it('distinguishes an origin that has no main branch', () => {
    const fixture = createFixture()
    const emptyRemote = path.join(fixture.parent, 'empty origin.git')
    git(fixture.parent, ['init', '--bare', emptyRemote])
    git(fixture.root, ['remote', 'set-url', 'origin', emptyRemote])

    const result = runCheck(fixture.root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[main-baseline] FAILED code=MISSING_BASE_BRANCH')
  })

  it('distinguishes an unreachable origin', () => {
    const fixture = createFixture()
    git(fixture.root, ['remote', 'set-url', 'origin', path.join(fixture.parent, 'does not exist.git')])

    const result = runCheck(fixture.root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[main-baseline] FAILED code=REMOTE_UNREACHABLE')
  })

  it('distinguishes a fetch failure after the remote main is resolved', () => {
    const fixture = createFixture()
    advanceMain(fixture)
    const lockPath = resolveGitPath(fixture.root, 'refs/remotes/origin/main.lock')
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, 'locked by RED-92 fixture')

    const result = runCheck(fixture.root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[main-baseline] FAILED code=FETCH_FAILED')
  })

  it('checks a detached real PR head before and after the same head branch incorporates main', () => {
    const fixture = createFixture()
    const ciEnvironment = { RVB_BASELINE_HEAD_REF: 'codex/RED-92-ci-head' }
    git(fixture.root, ['switch', '--detach'])

    const localResult = runCheck(fixture.root)
    const currentCiResult = runCheck(fixture.root, { args: ['--ci'], env: ciEnvironment })

    expect(localResult.status).toBe(1)
    expect(localResult.stderr).toContain('[main-baseline] FAILED code=DETACHED_HEAD')
    expect(currentCiResult.status).toBe(0)
    expect(currentCiResult.stdout).toContain('Branch: codex/RED-92-ci-head (detached CI head)')

    advanceMain(fixture)
    const staleCiResult = runCheck(fixture.root, { args: ['--ci'], env: ciEnvironment })
    expect(staleCiResult.status).toBe(1)
    expect(staleCiResult.stderr).toContain('[main-baseline] FAILED code=BEHIND_MAIN')

    git(fixture.root, ['switch', 'codex/RED-92-fixture'])
    git(fixture.root, ['merge', 'origin/main', '--no-edit'])
    git(fixture.root, ['switch', '--detach'])
    const synchronizedCiResult = runCheck(fixture.root, { args: ['--ci'], env: ciEnvironment })

    expect(synchronizedCiResult.status).toBe(0)
    expect(synchronizedCiResult.stdout).toContain('Behind: 0')
  })

  it.each([
    'feature/no-ticket',
    'feature/shared-123',
    'feature/pred-123',
    'feature/RED-123abc',
  ])('rejects a branch name without a standalone Linear issue token: %s', (branchName) => {
    const fixture = createFixture(branchName)

    const result = runCheck(fixture.root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[main-baseline] FAILED code=INVALID_BRANCH_NAME')
    expect(result.stderr).toContain('RED-###')
  })

  it('warns about a dirty worktree without changing or hiding the local edits', () => {
    const fixture = createFixture()
    writeFile(fixture.root, 'local notes.txt', 'keep this user change\n')
    const before = fingerprintWorkingTree(fixture.root)

    const result = runCheck(fixture.root)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('[main-baseline] WARNING working tree has local changes')
    expect(result.stderr).toContain('save or commit them before synchronizing main')
    expect(fingerprintWorkingTree(fixture.root)).toBe(before)
    expect(git(fixture.root, ['status', '--porcelain', '--untracked-files=all'])).toContain('local notes.txt')
  })

  it('distinguishes insufficient shallow history from a normal no-common-ancestor failure', () => {
    const shallowFixture = createFixture()
    replaceMainWithUnrelatedHistory(shallowFixture)
    const shallowBoundary = git(shallowFixture.root, ['rev-parse', 'HEAD'])
    fs.writeFileSync(resolveGitPath(shallowFixture.root, 'shallow'), `${shallowBoundary}\n`)

    const shallowResult = runCheck(shallowFixture.root)

    expect(shallowResult.status).toBe(1)
    expect(shallowResult.stderr).toContain('[main-baseline] FAILED code=SHALLOW_HISTORY_INSUFFICIENT')

    const unrelatedFixture = createFixture()
    replaceMainWithUnrelatedHistory(unrelatedFixture)

    const unrelatedResult = runCheck(unrelatedFixture.root)

    expect(unrelatedResult.status).toBe(1)
    expect(unrelatedResult.stderr).toContain('[main-baseline] FAILED code=NO_COMMON_ANCESTOR')
  })

  it('wires the package command and workflow to the real pull request head', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    const workflow = fs.readFileSync(path.resolve('.github/workflows/main-baseline.yml'), 'utf8')
    const source = fs.readFileSync(sourceScript, 'utf8')

    expect(packageJson.scripts['check:main-baseline']).toBe('node scripts/check-main-baseline.mjs')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha }}')
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('RVB_BASELINE_HEAD_REF: ${{ github.event.pull_request.head.ref }}')
    expect(workflow).toContain('node scripts/check-main-baseline.mjs --ci')
    expect(workflow).not.toContain('refs/pull/')
    expect(workflow).not.toContain('github.sha')

    for (const command of ['rebase', 'merge', 'stash', 'commit', 'reset', 'checkout', 'switch', 'push']) {
      expect(source).not.toMatch(new RegExp(`runGit\\(\\s*\\[\\s*['\"]${command}['\"]`))
    }
  })
})
