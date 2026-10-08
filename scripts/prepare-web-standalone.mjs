import fs from 'node:fs'
import path from 'node:path'

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory()
  } catch {
    return false
  }
}

function requireFile(filePath, description) {
  if (!isFile(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`)
  }
}

function requireDirectory(directoryPath, description) {
  if (!isDirectory(directoryPath)) {
    throw new Error(`Missing ${description}: ${directoryPath}`)
  }
}

function copyDirectory(sourcePath, targetPath, standaloneRoot, projectRoot) {
  standaloneRoot = path.resolve(standaloneRoot)
  projectRoot = path.resolve(projectRoot)
  const resolvedTarget = path.resolve(targetPath)
  const relativeTarget = path.relative(standaloneRoot, resolvedTarget)
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new Error(`Unsafe standalone copy target: ${targetPath}`)
  }

  let current = resolvedTarget
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Unsafe standalone copy target: symbolic link in ${current}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (current === projectRoot) break
    if (!current.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Unsafe standalone copy target: ${targetPath}`)
    }
    current = path.dirname(current)
  }

  fs.rmSync(targetPath, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true })
}

export function prepareWebStandalone(projectRoot) {
  const nextRoot = path.join(projectRoot, '.next')
  const standaloneRoot = path.join(nextRoot, 'standalone')
  const serverPath = path.join(standaloneRoot, 'server.js')
  const staticSource = path.join(nextRoot, 'static')
  const publicSource = path.join(projectRoot, 'public')
  const staticTarget = path.join(standaloneRoot, '.next', 'static')
  const publicTarget = path.join(standaloneRoot, 'public')

  requireDirectory(standaloneRoot, 'Next standalone directory')
  requireFile(
    serverPath,
    'flat Next standalone server (nested output is unsupported; check next.config.ts roots)',
  )
  requireDirectory(staticSource, 'Next static output')
  requireDirectory(publicSource, 'public assets')

  copyDirectory(staticSource, staticTarget, standaloneRoot, projectRoot)
  copyDirectory(publicSource, publicTarget, standaloneRoot, projectRoot)

  requireDirectory(staticTarget, 'copied standalone static output')
  requireDirectory(publicTarget, 'copied standalone public output')

  return { standaloneRoot, serverPath, staticTarget, publicTarget }
}
