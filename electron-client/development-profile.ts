import * as path from 'path'

const DEVELOPMENT_PROFILE_SWITCH = '--rvb-dev-profile'
const DEVELOPMENT_PROFILE_PREFIX = `${DEVELOPMENT_PROFILE_SWITCH}=`
const DEVELOPMENT_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export interface DevelopmentProfile {
  name: string
  userDataPath: string
}

export function resolveDevelopmentProfile(
  argv: readonly string[],
  isPackaged: boolean,
  defaultUserData: string,
): DevelopmentProfile | null {
  const argumentsForProfile = argv.filter((argument) => (
    argument === DEVELOPMENT_PROFILE_SWITCH || argument.startsWith(DEVELOPMENT_PROFILE_PREFIX)
  ))

  if (argumentsForProfile.length === 0) return null
  if (argumentsForProfile.length > 1) {
    throw new Error('The development profile argument can be provided only once.')
  }
  if (isPackaged) {
    throw new Error('Named development profiles are only available in development builds.')
  }

  const argument = argumentsForProfile[0]
  const name = argument.startsWith(DEVELOPMENT_PROFILE_PREFIX)
    ? argument.slice(DEVELOPMENT_PROFILE_PREFIX.length)
    : ''
  if (!DEVELOPMENT_PROFILE_NAME.test(name)) {
    throw new Error('Invalid development profile. Use 1-32 ASCII letters, numbers, hyphens, or underscores, starting with a letter or number.')
  }

  const profileRoot = path.resolve(defaultUserData, 'dev-profiles')
  const userDataPath = path.resolve(profileRoot, name)
  const relativePath = path.relative(profileRoot, userDataPath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Invalid development profile path.')
  }

  return { name, userDataPath }
}
