import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const remoteName = 'origin'
const baseBranch = 'main'
const baseRef = `refs/remotes/${remoteName}/${baseBranch}`
const displayBaseRef = `${remoteName}/${baseBranch}`
const projectRoot = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))

function comparablePath(value) {
  const resolved = fs.realpathSync.native(path.resolve(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function redactCredentials(value) {
  return String(value || '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .trim()
}

function runGit(args) {
  return spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
    windowsHide: true,
  })
}

function gitFailure(result) {
  if (result.error) return redactCredentials(result.error.message)
  return redactCredentials(result.stderr || result.stdout || `git exited with status ${result.status}`)
}

function fail(code, lines = []) {
  console.error(`[main-baseline] FAILED code=${code}`)
  for (const line of lines) console.error(line)
  return 1
}

function summaryLines({ branchLabel, head, base, ahead, behind }) {
  return [
    `Repository: ${projectRoot}`,
    `Branch: ${branchLabel}`,
    `HEAD: ${head}`,
    `Base (${displayBaseRef}): ${base}`,
    `Ahead: ${ahead}`,
    `Behind: ${behind}`,
  ]
}

function main() {
  const argumentsList = process.argv.slice(2)
  const unknownArguments = argumentsList.filter((argument) => argument !== '--ci')
  if (unknownArguments.length > 0 || argumentsList.filter((argument) => argument === '--ci').length > 1) {
    return fail('INVALID_ARGUMENTS', [
      `Unsupported arguments: ${unknownArguments.join(', ') || argumentsList.join(', ')}`,
      'Usage: node scripts/check-main-baseline.mjs [--ci]',
    ])
  }
  const ciMode = argumentsList.includes('--ci')

  const repositoryResult = runGit(['rev-parse', '--show-toplevel'])
  if (repositoryResult.status !== 0) {
    return fail('NOT_GIT_REPOSITORY', [
      `Repository: ${projectRoot}`,
      gitFailure(repositoryResult),
    ])
  }
  const gitRoot = path.resolve(repositoryResult.stdout.trim())
  if (comparablePath(gitRoot) !== comparablePath(projectRoot)) {
    return fail('SCRIPT_OUTSIDE_REPOSITORY_ROOT', [
      `Script root: ${projectRoot}`,
      `Git root: ${gitRoot}`,
      'Run the checked-in script from the repository that owns it.',
    ])
  }

  const symbolicBranchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const detachedHead = symbolicBranchResult.status !== 0
  let branchName
  if (ciMode) {
    branchName = String(process.env.RVB_BASELINE_HEAD_REF || '').trim()
    if (!branchName) {
      return fail('MISSING_CI_HEAD_REF', [
        `Repository: ${projectRoot}`,
        'CI mode requires RVB_BASELINE_HEAD_REF to contain the real pull request head branch.',
      ])
    }
  } else if (detachedHead) {
    return fail('DETACHED_HEAD', [
      `Repository: ${projectRoot}`,
      'Local baseline checks require a named task branch containing RED-###.',
      'Detached pull request heads are accepted only with --ci and RVB_BASELINE_HEAD_REF.',
    ])
  } else {
    branchName = symbolicBranchResult.stdout.trim()
  }

  if (!/(^|[^a-z0-9])red-\d+($|[^a-z0-9])/i.test(branchName)) {
    return fail('INVALID_BRANCH_NAME', [
      `Repository: ${projectRoot}`,
      `Branch: ${branchName}`,
      'Task branches must contain a Linear issue number in the form RED-###.',
    ])
  }
  const branchLabel = ciMode && detachedHead ? `${branchName} (detached CI head)` : branchName

  const remoteResult = runGit(['remote', 'get-url', remoteName])
  if (remoteResult.status !== 0 || !remoteResult.stdout.trim()) {
    return fail('MISSING_REMOTE', [
      `Repository: ${projectRoot}`,
      `Required remote: ${remoteName}`,
      'Configure the repository origin before checking the main baseline.',
    ])
  }

  const remoteMainResult = runGit(['ls-remote', '--exit-code', '--heads', remoteName, `refs/heads/${baseBranch}`])
  if (remoteMainResult.status === 2) {
    return fail('MISSING_BASE_BRANCH', [
      `Repository: ${projectRoot}`,
      `Remote ${remoteName} does not publish refs/heads/${baseBranch}.`,
    ])
  }
  if (remoteMainResult.status !== 0) {
    return fail('REMOTE_UNREACHABLE', [
      `Repository: ${projectRoot}`,
      `Unable to query ${remoteName}/${baseBranch}.`,
      gitFailure(remoteMainResult),
    ])
  }

  const fetchResult = runGit([
    'fetch',
    '--prune',
    '--no-tags',
    remoteName,
    `+refs/heads/${baseBranch}:${baseRef}`,
  ])
  if (fetchResult.status !== 0) {
    return fail('FETCH_FAILED', [
      `Repository: ${projectRoot}`,
      `Failed to refresh ${displayBaseRef}; no cached ref was accepted as current.`,
      gitFailure(fetchResult),
    ])
  }

  const headResult = runGit(['rev-parse', 'HEAD'])
  if (headResult.status !== 0) {
    return fail('MISSING_HEAD', [`Repository: ${projectRoot}`, gitFailure(headResult)])
  }
  const baseResult = runGit(['rev-parse', '--verify', baseRef])
  if (baseResult.status !== 0) {
    return fail('MISSING_BASE_REF', [
      `Repository: ${projectRoot}`,
      `The refreshed ${displayBaseRef} reference is unavailable.`,
      gitFailure(baseResult),
    ])
  }
  const head = headResult.stdout.trim()
  const base = baseResult.stdout.trim()

  const statusResult = runGit(['status', '--porcelain', '--untracked-files=all'])
  if (statusResult.status !== 0) {
    return fail('STATUS_FAILED', [
      `Repository: ${projectRoot}`,
      gitFailure(statusResult),
    ])
  }
  const dirty = statusResult.stdout.trim().length > 0

  const mergeBaseResult = runGit(['merge-base', 'HEAD', baseRef])
  if (mergeBaseResult.status !== 0) {
    const shallowResult = runGit(['rev-parse', '--is-shallow-repository'])
    const shallow = shallowResult.status === 0 && shallowResult.stdout.trim() === 'true'
    return fail(shallow ? 'SHALLOW_HISTORY_INSUFFICIENT' : 'NO_COMMON_ANCESTOR', [
      `Repository: ${projectRoot}`,
      `Branch: ${branchLabel}`,
      `HEAD: ${head}`,
      `Base (${displayBaseRef}): ${base}`,
      shallow
        ? 'The shallow checkout does not contain enough history to prove the main ancestry. Fetch full history and retry.'
        : 'HEAD and origin/main do not have a verifiable common ancestor.',
    ])
  }

  const countResult = runGit(['rev-list', '--left-right', '--count', `HEAD...${baseRef}`])
  const countParts = countResult.stdout.trim().split(/\s+/)
  const ahead = Number.parseInt(countParts[0], 10)
  const behind = Number.parseInt(countParts[1], 10)
  if (countResult.status !== 0 || countParts.length !== 2 || !Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return fail('COUNT_FAILED', [
      `Repository: ${projectRoot}`,
      gitFailure(countResult),
    ])
  }

  const ancestorResult = runGit(['merge-base', '--is-ancestor', baseRef, 'HEAD'])
  if (ancestorResult.status !== 0 || behind > 0) {
    const details = summaryLines({ branchLabel, head, base, ahead, behind })
    return fail('BEHIND_MAIN', [
      ...details,
      `The branch does not contain the latest ${displayBaseRef}.`,
      'Recovery for an individual short-lived branch:',
      '  git fetch origin',
      '  git rebase origin/main',
      'Shared branches must choose merge explicitly with the branch owner; this check never rewrites history.',
    ])
  }

  if (dirty) {
    console.error('[main-baseline] WARNING working tree has local changes; save or commit them before synchronizing main.')
  }
  console.log('[main-baseline] OK')
  for (const line of summaryLines({ branchLabel, head, base, ahead, behind })) console.log(line)
  return 0
}

process.exitCode = main()
