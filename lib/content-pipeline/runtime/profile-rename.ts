import { existsSync, renameSync } from 'node:fs'

type ProfileDirectoryRenameWaitV1 = (milliseconds: number) => void

const PROFILE_DIRECTORY_RENAME_RETRIES_V1 = 3
const PROFILE_DIRECTORY_RENAME_DELAY_MS_V1 = 100
const profileDirectoryRenameWaitBufferV1 = new Int32Array(new SharedArrayBuffer(4))

function nativeProfileDirectoryRenameWaitV1(milliseconds: number): void {
  Atomics.wait(profileDirectoryRenameWaitBufferV1, 0, 0, milliseconds)
}

function isWindowsTransientProfileDirectoryRenameErrorV1(error: unknown): boolean {
  if (process.platform !== 'win32' || !error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * Internal profile/package directory commit primitive. It is intentionally not
 * exported from a public runtime barrel: callers retain their own destination
 * validation and transaction handling around this bounded Windows retry.
 */
export function renameProfileDirectoryWithWindowsRetryV1(
  temporary: string,
  destination: string,
  wait: ProfileDirectoryRenameWaitV1 = nativeProfileDirectoryRenameWaitV1,
): void {
  let originalError: unknown
  for (let retry = 0; ; retry += 1) {
    try {
      renameSync(temporary, destination)
      return
    } catch (error) {
      originalError ??= error
      if (!isWindowsTransientProfileDirectoryRenameErrorV1(error)) throw error
      if (retry >= PROFILE_DIRECTORY_RENAME_RETRIES_V1 || existsSync(destination)) {
        throw originalError
      }
      wait(PROFILE_DIRECTORY_RENAME_DELAY_MS_V1)
    }
  }
}