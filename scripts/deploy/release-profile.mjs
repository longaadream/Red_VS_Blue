import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// profile-archive.ts retains its audited CommonJS AdmZip boundary.  Keep the
// bundled production entry executable as ESM by providing the same trusted
// require primitive that the source runtime receives from Node.
globalThis.require ??= createRequire(import.meta.url)

const HASH = /^[a-f0-9]{64}$/

function usage() {
  return [
    'Usage:',
    '  install-profile.mjs inspect --app-root PATH --state-root PATH [--expected-stable HASH]',
    '  install-profile.mjs install --app-root PATH --state-root PATH --archive PATH',
    '    --expected-stable HASH --expected-new HASH [--expected-package HASH]',
    '  install-profile.mjs rollback --app-root PATH --state-root PATH',
    '    --expected-stable HASH --expected-previous HASH',
  ].join('\n')
}

function fail(message, status = 2) {
  const error = new Error(message)
  error.exitCode = status
  throw error
}

function parseArguments(argv) {
  const command = argv[0]
  if (!['inspect', 'install', 'rollback'].includes(command)) fail(usage())
  const values = { command }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) fail(`Unknown argument: ${argument}`)
    const name = argument.slice(2)
    if (!['app-root', 'state-root', 'archive', 'expected-stable', 'expected-new', 'expected-previous', 'expected-package'].includes(name)) {
      fail(`Unknown argument: ${argument}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) fail(`Missing value for --${name}`)
    if (values[name]) fail(`Duplicate argument: --${name}`)
    values[name] = value
  }
  for (const name of ['app-root', 'state-root']) {
    if (!values[name]) fail(`Missing required argument: --${name}`)
    if (!path.isAbsolute(values[name])) fail(`--${name} must be an absolute path`)
  }
  if (command === 'inspect' && values.archive) fail('--archive is only valid for install')
  if (command === 'install' && !values.archive) fail('Missing required argument: --archive')
  if (command === 'install' && values.archive && !path.isAbsolute(values.archive)) fail('--archive must be an absolute path')
  if (command === 'rollback' && (values.archive || values['expected-new'] || values['expected-package'])) {
    fail('--archive, --expected-new and --expected-package are only valid for install')
  }
  for (const name of ['expected-stable', 'expected-new', 'expected-previous', 'expected-package']) {
    if (values[name] && !HASH.test(values[name])) fail(`--${name} must be a lowercase SHA-256 hash`)
  }
  if (command === 'install' && (!values['expected-stable'] || !values['expected-new'])) {
    fail('install requires --expected-stable and --expected-new')
  }
  if (command === 'install' && values['expected-stable'] === values['expected-new']) {
    fail('install expected-stable and expected-new must differ')
  }
  if (command === 'rollback' && (!values['expected-stable'] || !values['expected-previous'])) {
    fail('rollback requires --expected-stable and --expected-previous')
  }
  return values
}

function referenceIdentity(reference) {
  if (!reference) return null
  return {
    kind: reference.kind,
    resolvedProfileHash: reference.resolvedProfileHash,
    authorityContentHash: reference.authorityContentHash,
    engineAbi: reference.compatibility.engineAbi,
    contentAbi: reference.compatibility.contentAbi,
    packageId: reference.packageId,
    version: reference.version,
    capabilities: [...reference.capabilities],
  }
}

function identityOutput(command, changed, state, extra = {}) {
  const stable = referenceIdentity(state.stable)
  const previousStable = referenceIdentity(state.previousStable)
  return {
    schemaVersion: 'rvb-release-profile-result/v1',
    command,
    changed,
    stable,
    previousStable,
    ...extra,
  }
}

function assertExpected(value, expected, label) {
  if (expected && value !== expected) fail(`${label} mismatch: expected ${expected}, got ${value}`)
}

function clearInheritedProfileEnvironment() {
  for (const name of [
    'RVB_PROFILE_ROOT',
    'RVB_RESOLVED_PROFILE_HASH',
    'RVB_AUTHORITY_CONTENT_HASH',
    'RVB_PROFILE_ENGINE_ABI',
    'RVB_PROFILE_CONTENT_ABI',
    'RVB_PROFILE_ACTIVATION_ID',
    'RVB_PROFILE_ADMISSION_PAUSED',
  ]) delete process.env[name]
}

async function run(values) {
  // These must be set before loading the runtime.  ProfileStore's root is
  // derived by getProfileRuntimeContextV1 as <state-root>/resource-pack.
  process.env.APP_ROOT_DIR = path.resolve(values['app-root'])
  process.env.USER_DATA_DIR = path.resolve(values['state-root'])
  clearInheritedProfileEnvironment()

  const [{ getProfileRuntimeContextV1 }, { installProfileArchiveV1 }] = await Promise.all([
    import('../../lib/content-pipeline/runtime/profile-runtime.ts'),
    import('../../lib/content-pipeline/runtime/profile-archive.ts'),
  ])
  const context = getProfileRuntimeContextV1()

  if (values.command === 'inspect') {
    // Preflight runs while the services are live.  It may prove the current
    // stable reference, but it must never recover or rewrite an activation
    // journal that another process may still own.
    const state = context.store.readState()
    if (state.activation) fail('PROFILE_ACTIVATION_IN_PROGRESS: inspect refuses an unfinished activation')
    assertExpected(state.stable.resolvedProfileHash, values['expected-stable'], 'stable profile hash')
    context.store.verifyReference(state.stable)
    return identityOutput('inspect', false, state)
  }

  if (values.command === 'rollback') {
    let state = context.store.recoverInterruptedActivation()
    context.store.verifyReference(state.stable)
    if (state.stable.resolvedProfileHash === values['expected-previous']) {
      if (state.previousStable
        && state.previousStable.resolvedProfileHash !== values['expected-stable']
        && state.previousStable.resolvedProfileHash !== values['expected-previous']) {
        fail(`previous-stable profile hash mismatch: expected ${values['expected-stable']} or ${values['expected-previous']}, got ${state.previousStable.resolvedProfileHash}`)
      }
      return identityOutput('rollback', false, state, { skipped: true })
    }
    assertExpected(state.previousStable?.resolvedProfileHash, values['expected-previous'], 'previous-stable profile hash')
    assertExpected(state.stable.resolvedProfileHash, values['expected-stable'], 'stable profile hash')
    state = context.store.selectRollbackCandidate('previous-stable')
    const candidateHash = state.candidate?.resolvedProfileHash
    assertExpected(candidateHash, values['expected-previous'], 'rollback candidate profile hash')
    const activation = context.store.beginActivation(candidateHash)
    state = context.store.commitActivation(activation.activationId, candidateHash)
    assertExpected(state.stable.resolvedProfileHash, values['expected-previous'], 'rolled-back stable profile hash')
    assertExpected(state.previousStable?.resolvedProfileHash, values['expected-stable'], 'rolled-back previous-stable profile hash')
    return identityOutput('rollback', true, state)
  }

  let state = context.store.recoverInterruptedActivation()
  if (state.stable.resolvedProfileHash !== values['expected-stable']
    && state.stable.resolvedProfileHash !== values['expected-new']) {
    fail(`stable profile hash mismatch: expected ${values['expected-stable']} or ${values['expected-new']}, got ${state.stable.resolvedProfileHash}`)
  }
  context.store.verifyReference(state.stable)

  // A repeated deploy against the already active identity is a verified
  // no-op.  This avoids creating a new candidate or activation transaction.
  if (state.stable.resolvedProfileHash === values['expected-new']) {
    if (!state.previousStable || state.previousStable.resolvedProfileHash !== values['expected-stable']) {
      fail(`previous-stable profile hash mismatch: expected ${values['expected-stable']}, got ${state.previousStable?.resolvedProfileHash ?? 'missing'}`)
    }
    return identityOutput('install', false, state, { packageHash: null, reloadMode: 'already-stable' })
  }

  const archivePath = path.resolve(values.archive)
  if (!fs.statSync(archivePath).isFile()) fail(`Archive is not a file: ${archivePath}`)
  const installed = installProfileArchiveV1({
    store: context.store,
    appRoot: context.appRoot,
    archive: new Uint8Array(fs.readFileSync(archivePath)),
    allowLocalDevUnsigned: false,
  })
  assertExpected(installed.reference.resolvedProfileHash, values['expected-new'], 'installed profile hash')
  assertExpected(installed.profile.base.packageHash, values['expected-package'], 'installed package hash')

  const activation = context.store.beginActivation(installed.reference.resolvedProfileHash)
  state = context.store.commitActivation(activation.activationId, installed.reference.resolvedProfileHash)
  assertExpected(state.stable.resolvedProfileHash, values['expected-new'], 'stable profile hash after install')
  assertExpected(state.previousStable?.resolvedProfileHash, values['expected-stable'], 'previous-stable profile hash after install')
  return identityOutput('install', true, state, {
    packageHash: installed.profile.base.packageHash,
    reloadMode: installed.reloadMode,
  })
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArguments(argv)
  const result = await run(values)
  // stdout is intentionally one identity JSON document.  Operational logs
  // belong to the caller and signed package contents never appear here.
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
  })
}
