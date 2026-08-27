import { z } from 'zod'

const CONTENT_ID_V1_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/
const SEMVER_V1_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256_HEX_V1_PATTERN = /^[0-9a-f]{64}$/
const ABI_VERSION_V1_PATTERN = /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9.-]*)*\/v(?:0|[1-9]\d*)$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const WINDOWS_FORBIDDEN_CHARACTER_PATTERN = /[<>:\"|?*]/
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const UTF8_ENCODER = new TextEncoder()

export const ContentIdV1Schema = z.string()
  .min(1)
  .max(128)
  .regex(
    CONTENT_ID_V1_PATTERN,
    'Content ID must be lowercase ASCII and use only letters, digits, dot, underscore, colon, or hyphen',
  )

export type ContentIdV1 = z.infer<typeof ContentIdV1Schema>

export const SemVerV1Schema = z.string()
  .max(128)
  .regex(SEMVER_V1_PATTERN, 'Version must be a valid SemVer 2.0.0 string')

export type SemVerV1 = z.infer<typeof SemVerV1Schema>

export const Sha256HexV1Schema = z.string()
  .regex(SHA256_HEX_V1_PATTERN, 'SHA-256 must be 64 lowercase hexadecimal characters')

export type Sha256HexV1 = z.infer<typeof Sha256HexV1Schema>

export const AbiVersionV1Schema = z.string()
  .max(128)
  .regex(ABI_VERSION_V1_PATTERN, 'ABI version must use a lowercase name followed by /vN')

export type AbiVersionV1 = z.infer<typeof AbiVersionV1Schema>

export function compareUnicodeCodePointsV1(left: string, right: string): number {
  const leftCodePoints = Array.from(left, character => character.codePointAt(0)!)
  const rightCodePoints = Array.from(right, character => character.codePointAt(0)!)
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length)

  for (let index = 0; index < sharedLength; index += 1) {
    if (leftCodePoints[index] < rightCodePoints[index]) return -1
    if (leftCodePoints[index] > rightCodePoints[index]) return 1
  }

  if (leftCodePoints.length < rightCodePoints.length) return -1
  if (leftCodePoints.length > rightCodePoints.length) return 1
  return 0
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

export const UnicodeScalarStringV1Schema = z.string().superRefine((value, context) => {
  if (!isWellFormedUnicode(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'String must contain only well-formed Unicode scalar values',
    })
  }
})

export type UnicodeScalarStringV1 = z.infer<typeof UnicodeScalarStringV1Schema>
function isCanonicalPosixRelativePath(value: string): boolean {
  if (
    value.length === 0
    || value.length > 512
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || /^[A-Za-z]:/.test(value)
    || CONTROL_CHARACTER_PATTERN.test(value)
    || WINDOWS_FORBIDDEN_CHARACTER_PATTERN.test(value)
    || !isWellFormedUnicode(value)
    || value !== value.normalize('NFC')
  ) {
    return false
  }

  const segments = value.split('/')
  return segments.every(segment => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.endsWith('.')
    && !segment.endsWith(' ')
    && !WINDOWS_RESERVED_BASENAME_PATTERN.test(segment)
    && UTF8_ENCODER.encode(segment).length <= 255
  ))
}

export const PosixRelativePathV1Schema = UnicodeScalarStringV1Schema.superRefine((value, context) => {
  if (!isCanonicalPosixRelativePath(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Path must be a canonical cross-platform NFC POSIX relative path',
    })
  }
})

export type PosixRelativePathV1 = z.infer<typeof PosixRelativePathV1Schema>

export type JsonPrimitiveV1 = null | boolean | number | string

export type JsonValueV1 =
  | JsonPrimitiveV1
  | JsonValueV1[]
  | { [key: string]: JsonValueV1 }

export const JsonPrimitiveV1Schema: z.ZodType<JsonPrimitiveV1> = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  UnicodeScalarStringV1Schema,
])

const JsonPlainObjectInputV1Schema = z.custom<Record<string, unknown>>(
  value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  },
  'JSON object values must be plain objects',
)

export const JsonValueV1Schema: z.ZodType<JsonValueV1, z.ZodTypeDef, unknown> = z.lazy(() => z.union([
  JsonPrimitiveV1Schema,
  z.array(JsonValueV1Schema),
  JsonPlainObjectInputV1Schema.pipe(z.record(UnicodeScalarStringV1Schema, JsonValueV1Schema)),
]))
