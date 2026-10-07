import * as fs from 'node:fs'
import * as path from 'node:path'

export const WINDOW_PREFERENCES_SCHEMA = 'rvb-window-preferences/v1' as const

export type WindowPreferences = Readonly<{
  schema: typeof WINDOW_PREFERENCES_SCHEMA
  fullscreen: boolean
}>

type WindowPreferencesLogger = Pick<Console, 'warn'>

const DEFAULT_WINDOW_PREFERENCES: WindowPreferences = {
  schema: WINDOW_PREFERENCES_SCHEMA,
  fullscreen: true,
}

export function getWindowPreferencesPath(userDataPath: string): string {
  return path.join(userDataPath, 'rvb-window-preferences.json')
}

function isWindowPreferences(value: unknown): value is WindowPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as { schema?: unknown; fullscreen?: unknown }
  return candidate.schema === WINDOW_PREFERENCES_SCHEMA && typeof candidate.fullscreen === 'boolean'
}

export function readWindowPreferences(
  userDataPath: string,
  logger: WindowPreferencesLogger = console,
): WindowPreferences {
  const filePath = getWindowPreferencesPath(userDataPath)
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!isWindowPreferences(value)) throw new Error('invalid schema or fullscreen value')
    return { schema: WINDOW_PREFERENCES_SCHEMA, fullscreen: value.fullscreen }
  } catch (error) {
    if (fs.existsSync(filePath)) {
      logger.warn('[window-preferences] invalid or corrupt preferences; using fullscreen default', error)
    }
    return { ...DEFAULT_WINDOW_PREFERENCES }
  }
}

export function writeWindowPreferences(userDataPath: string, fullscreen: boolean): WindowPreferences {
  if (typeof fullscreen !== 'boolean') throw new Error('fullscreen preference must be a boolean')

  const filePath = getWindowPreferencesPath(userDataPath)
  const temporaryPath = `${filePath}.tmp`
  const preferences: WindowPreferences = {
    schema: WINDOW_PREFERENCES_SCHEMA,
    fullscreen,
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(preferences) + '\n', 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(temporaryPath) } catch {}
    throw error
  }

  return preferences
}
