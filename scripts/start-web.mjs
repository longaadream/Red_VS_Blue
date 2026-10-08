import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function standaloneServerPath(root) {
  return path.join(root, '.next', 'standalone', 'server.js')
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** @param {string} root @param {Record<string, string | undefined>} [environment] */
export function configureWebEnvironment(root, environment = process.env) {
  environment.APP_ROOT_DIR = path.resolve(root, environment.APP_ROOT_DIR ?? root)
  environment.USER_DATA_DIR = path.resolve(root, environment.USER_DATA_DIR ?? root)
  return environment
}

export async function startWebServer(root = projectRoot) {
  const serverPath = standaloneServerPath(root)
  if (!isFile(serverPath)) {
    throw new Error(
      `Web build output is missing: expected standalone server at ${serverPath}. Run "npm run build" from the repository root.`,
    )
  }

  configureWebEnvironment(root)
  await import(pathToFileURL(serverPath).href)
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  startWebServer().catch((error) => {
    console.error(`[web-start] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}
