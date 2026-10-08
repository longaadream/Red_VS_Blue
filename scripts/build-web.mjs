import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { prepareWebStandalone } from './prepare-web-standalone.mjs'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createStepError(name, status, signal, cause) {
  const detail = cause
    ? `could not start: ${cause.message}`
    : signal
      ? `terminated by ${signal}`
      : `exited with code ${status}`
  const error = new Error(`Build step "${name}" ${detail}`)
  error.step = name
  error.exitCode = Number.isInteger(status) && status > 0 ? status : 1
  if (cause) error.cause = cause
  return error
}

/**
 * @param {{ name: string, command: string, args?: string[], cwd?: string, env?: Record<string, string | undefined>, stdio?: string | string[] }} options
 */
export function runStep({ name, command, args = [], cwd = projectRoot, env = process.env, stdio = 'inherit' }) {
  console.log(`[build-web] START step="${name}"`)
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio,
      windowsHide: true,
    })

    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(createStepError(name, 1, null, error))
    })
    child.once('close', (status, signal) => {
      if (settled) return
      settled = true
      if (status === 0) resolve()
      else reject(createStepError(name, status, signal))
    })
  })
}

function localScript(scriptName) {
  return path.join(projectRoot, 'scripts', scriptName)
}

async function runLocalScript(name, scriptName, args = []) {
  await runStep({
    name,
    command: process.execPath,
    args: [localScript(scriptName), ...args],
  })
}

export async function buildWeb(args = process.argv.slice(2)) {
  await runLocalScript('practice worker', 'build-practice-ai.mjs')
  await runLocalScript('adventure worker', 'build-adventure.mjs')
  await runLocalScript('Tailwind CSS', 'build-tailwind.mjs')
  await runStep({
    name: 'Next production build',
    command: process.execPath,
    args: [path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', ...args],
  })

  try {
    const output = prepareWebStandalone(projectRoot)
    console.log(`[build-web] Standalone output ready: ${output.serverPath}`)
    return output
  } catch (error) {
    error.step = 'standalone asset preparation'
    throw error
  }
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  buildWeb().catch((error) => {
    const step = error.step ?? 'unknown'
    console.error(`[build-web] FAILED step="${step}": ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  })
}
