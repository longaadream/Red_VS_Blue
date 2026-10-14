const FAST_CLONE_MAX_DEPTH = 256

const UNSUPPORTED = Symbol('unsupported JSON data')

function hasToJson(value: object): boolean {
  let current: object | null = value
  while (current) {
    try {
      if (Object.getOwnPropertyDescriptor(current, 'toJSON')) return true
      current = Object.getPrototypeOf(current)
    } catch {
      return true
    }
  }
  return false
}

function clonePureJson(value: unknown, depth: number, ancestors: object[]): unknown {
  if (value === null) return null

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : UNSUPPORTED
    case 'object':
      break
    default:
      return UNSUPPORTED
  }

  if (depth > FAST_CLONE_MAX_DEPTH) return UNSUPPORTED

  const objectValue = value as object
  if (ancestors.includes(objectValue)) return UNSUPPORTED
  ancestors.push(objectValue)

  try {
    const isArray = Array.isArray(objectValue)
    const prototype = Object.getPrototypeOf(objectValue)
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return UNSUPPORTED
    }
    // Only plain file-backed JSON data is optimized. Do not invoke getters or
    // toJSON while checking eligibility; native JSON handles unsupported data.
    if ('toJSON' in objectValue) return UNSUPPORTED
    const keys = Object.keys(objectValue)

    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(objectValue, 'length')
      if (!lengthDescriptor || !('value' in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        return UNSUPPORTED
      }
      const length = lengthDescriptor.value
      if (keys.length !== length) return UNSUPPORTED

      const clone: unknown[] = new Array(length)
      for (let index = 0; index < length; index += 1) {
        const key = String(index)
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          return UNSUPPORTED
        }
        const nested = clonePureJson(descriptor.value, depth + 1, ancestors)
        if (nested === UNSUPPORTED) return UNSUPPORTED
        if (key in clone) {
          Object.defineProperty(clone, key, { configurable: true, enumerable: true, value: nested, writable: true })
        } else {
          clone[index] = nested
        }
      }
      return clone
    }

    const clone: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        return UNSUPPORTED
      }
      const nested = clonePureJson(descriptor.value, depth + 1, ancestors)
      if (nested === UNSUPPORTED) return UNSUPPORTED
      // Inherited keys (including __proto__ and possible prototype setters)
      // need an own data property, exactly as JSON.parse would create.
      if (key in clone) {
        Object.defineProperty(clone, key, { configurable: true, enumerable: true, value: nested, writable: true })
      } else {
        clone[key] = nested
      }
    }
    return clone
  } finally {
    ancestors.pop()
  }
}

/**
 * Clone state using JSON semantics while avoiding a second full serialization of
 * the large, pure-data skillsById graph. Unsupported skill values fall back to
 * the same JSON.stringify traversal that handled them before this fast path.
 */
export function cloneBattleStateJson<T>(state: T): T {
  let optimizedSkills: unknown
  let optimized = false
  let fastPathDisabled = false

  const serialized = JSON.stringify(state, function (this: unknown, key: string, value: unknown) {
    if (key === '' && value === state) {
      try {
        if (hasToJson(state as object)) fastPathDisabled = true
      } catch {
        fastPathDisabled = true
      }
    }

    if (fastPathDisabled || key !== 'skillsById' || this !== state) return value

    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(state as object, key)
    } catch {
      fastPathDisabled = true
      return value
    }
    if (!descriptor || !('value' in descriptor) || descriptor.value !== value) {
      fastPathDisabled = true
      return value
    }

    const result = clonePureJson(value, 0, [])
    if (result === UNSUPPORTED) {
      fastPathDisabled = true
      return value
    }

    optimized = true
    optimizedSkills = result
    return null
  })

  const cloned = JSON.parse(serialized as string) as Record<string, unknown>
  if (optimized) {
    Object.defineProperty(cloned, 'skillsById', {
      configurable: true,
      enumerable: true,
      value: optimizedSkills,
      writable: true,
    })
  }
  return cloned as T
}
