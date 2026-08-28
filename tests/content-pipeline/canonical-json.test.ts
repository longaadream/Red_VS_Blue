import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import type {
  AuthorityContentIdentityV1,
  PackManifestV1,
  ResolvedProfileIdentityV1,
} from '@/lib/content-pipeline/contracts'
import * as contentPipelineCore from '@/lib/content-pipeline/core'
import {
  CanonicalJsonV1Error,
  canonicalJsonBytesV1,
  canonicalizeJsonV1,
} from '@/lib/content-pipeline/core/canonical-json'
import {
  bytesToLowerHexV1,
  computeAuthorityContentHashV1,
  computePackageHashV1,
  computeResolvedProfileHashV1,
  computeResolvedProfileIdentitiesV1,
  projectAuthorityContentIdentityV1,
} from '@/lib/content-pipeline/core/hash'
import {
  JsonSafetyErrorV1,
  parseStrictJsonBytesV1,
} from '@/lib/content-pipeline/core/json-safety'

const FILE_SHA256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
const PACKAGE_HASH = 'c5f7186b749342aba2fce56d5ab4583bb25c2071b1d45c7d5562a483e8c63152'
const PUBLISHER_KEY_ID = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9'

const manifest: PackManifestV1 = {
  schemaVersion: 'rvb-pack/v1',
  packageId: 'test.base',
  version: '1.0.0',
  displayName: 'Test',
  publisher: {
    id: 'test.publisher',
    keyId: PUBLISHER_KEY_ID,
  },
  compatibility: {
    engineAbi: 'rvb-engine/v1',
    contentAbi: 'rvb-content/v1',
  },
  capabilities: ['game-data'],
  files: [
    {
      path: 'data/core.json',
      mediaType: 'application/json',
      size: 2,
      sha256: FILE_SHA256,
    },
  ],
  kind: 'snapshot',
}

const profileIdentity: ResolvedProfileIdentityV1 = {
  schemaVersion: 'rvb-profile/v1',
  compatibility: {
    engineAbi: 'rvb-engine/v1',
    contentAbi: 'rvb-content/v1',
  },
  capabilities: ['game-data'],
  base: {
    packageId: 'test.base',
    version: '1.0.0',
    packageHash: PACKAGE_HASH,
  },
  patches: [],
  files: [
    {
      descriptor: {
        path: 'data/core.json',
        mediaType: 'application/json',
        size: 2,
        sha256: FILE_SHA256,
      },
      provenance: {
        packageHash: PACKAGE_HASH,
        operation: 'snapshot',
        sourcePath: 'data/core.json',
      },
    },
  ],
}

describe('RVB Canonical JSON v1', () => {
  it('matches the normative Unicode code-point ordering vector byte-for-byte', () => {
    const value = { '😀': 2, '\uE000': 1, a: -0 }
    const canonical = canonicalizeJsonV1(value)

    expect(canonical).toBe('{"a":0,"\uE000":1,"😀":2}')
    expect(bytesToLowerHexV1(canonicalJsonBytesV1(value))).toBe(
      '7b2261223a302c22ee8080223a312c22f09f9880223a327d',
    )
  })

  it('matches the normative escaping and binary64 rendering vector', () => {
    const value = {
      numbers: [-0, 1.23, 0.000001, 1e-7, 1e20, 1e21, 333333333.33333329],
      string: 'quote:" slash:/ backslash:\\ controls:\b\t\n\f\r\0 汉😀',
    }

    expect(canonicalizeJsonV1(value)).toBe(
      '{"numbers":[0,1.23,0.000001,1e-7,100000000000000000000,1e+21,333333333.3333333],'
      + '"string":"quote:\\" slash:/ backslash:\\\\ controls:\\b\\t\\n\\f\\r\\u0000 汉😀"}',
    )
  })

  it('keeps array order, does not normalize Unicode, and accepts null-prototype records', () => {
    const record = Object.create(null) as Record<string, unknown>
    record.z = ['second', 'first']
    record['cafe\u0301'] = 'é'

    expect(canonicalizeJsonV1(record)).toBe('{"café":"é","z":["second","first"]}')
  })

  it.each([
    ['Date', new Date('2026-08-27T00:00:00.000Z')],
    ['typed array', new Uint8Array([1])],
    ['function', () => undefined],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['lone high surrogate value', '\ud800'],
  ])('rejects non-JSON value %s', (_label, value) => {
    expect(() => canonicalizeJsonV1(value)).toThrow()
  })

  it('rejects accessors, symbol keys, non-enumerable fields, lone-surrogate keys, and sparse arrays', () => {
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    })
    const symbolKey = { safe: true } as Record<PropertyKey, unknown>
    symbolKey[Symbol('hidden')] = 1
    const nonEnumerable = Object.defineProperty({}, 'hidden', { value: 1 })
    const loneSurrogateKey = { ['\udfff']: true }
    const sparse = new Array(1)

    for (const value of [accessor, symbolKey, nonEnumerable, loneSurrogateKey, sparse]) {
      expect(() => canonicalizeJsonV1(value)).toThrow()
    }
  })

  it('rejects cycles but permits a shared acyclic value', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const shared = { value: 1 }

    expect(() => canonicalizeJsonV1(cyclic)).toThrow(/cyclic/i)
    expect(canonicalizeJsonV1({ left: shared, right: shared })).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    )
  })

  it('wraps hostile object inspection failures without leaking their message', () => {
    const hostile = new Proxy({ safe: true }, {
      ownKeys() {
        throw new Error('sensitive proxy details')
      },
    })

    let thrown: unknown
    try {
      canonicalizeJsonV1(hostile)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CanonicalJsonV1Error)
    expect((thrown as Error).message).not.toContain('sensitive proxy details')
  })

  it('does not trust an externally constructed CanonicalJsonV1Error', () => {
    const hostile = new Proxy({ safe: true }, {
      ownKeys() {
        throw new CanonicalJsonV1Error('sensitive forged canonical error')
      },
    })

    let thrown: unknown
    try {
      canonicalizeJsonV1(hostile)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CanonicalJsonV1Error)
    expect((thrown as Error).message).toBe('Canonical JSON input inspection failed')
  })

  it('does not inspect an untrusted thrown object while wrapping failures', () => {
    const hostileThrownValue = new Proxy(new Error('untrusted thrown value'), {
      getPrototypeOf() {
        throw new Error('sensitive instanceof trap')
      },
    })
    const hostile = new Proxy({ safe: true }, {
      ownKeys() {
        throw hostileThrownValue
      },
    })

    let thrown: unknown
    try {
      canonicalizeJsonV1(hostile)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CanonicalJsonV1Error)
    expect((thrown as Error).message).toBe('Canonical JSON input inspection failed')
  })
})

describe('Content Pipeline v1 strict JSON byte boundary', () => {
  it('accepts a cross-realm ordinary Uint8Array and ignores subclass traps', () => {
    const foreign = runInNewContext(
      'Uint8Array.from([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125])',
    ) as Uint8Array
    const hostile = Uint8Array.from([123, 125])
    Object.defineProperty(hostile, 'byteLength', {
      get() {
        throw new Error('byteLength trap must not run')
      },
    })
    Object.defineProperty(hostile, Symbol.iterator, {
      value() {
        throw new Error('iterator trap must not run')
      },
    })

    expect(parseStrictJsonBytesV1(foreign)).toEqual({ ok: true })
    expect(parseStrictJsonBytesV1(hostile)).toEqual({})
  })

  it('maps proxied and SharedArrayBuffer-backed bytes to JsonSafetyErrorV1', () => {
    const proxied = new Proxy(Uint8Array.from([123, 125]), {})
    const shared = new Uint8Array(new SharedArrayBuffer(2))
    shared.set([123, 125])

    for (const bytes of [proxied, shared]) {
      expect(() => parseStrictJsonBytesV1(bytes)).toThrow(JsonSafetyErrorV1)
    }
  })

  it('keeps internal content-tree constructors out of the public barrel', () => {
    expect('createReadonlyContentTreeV1' in contentPipelineCore).toBe(false)
    expect('snapshotOrdinaryUint8ArrayV1' in contentPipelineCore).toBe(false)
  })
})

describe('Content Pipeline v1 identities', () => {
  it('matches the package identity golden hash independent of object insertion order', () => {
    const reordered = {
      kind: manifest.kind,
      files: manifest.files,
      capabilities: manifest.capabilities,
      compatibility: manifest.compatibility,
      publisher: manifest.publisher,
      displayName: manifest.displayName,
      version: manifest.version,
      packageId: manifest.packageId,
      schemaVersion: manifest.schemaVersion,
    } satisfies PackManifestV1

    expect(computePackageHashV1(manifest)).toBe(PACKAGE_HASH)
    expect(computePackageHashV1(reordered)).toBe(PACKAGE_HASH)
  })

  it('matches the full-profile and authority-content golden hashes', () => {
    const authorityIdentity = projectAuthorityContentIdentityV1(profileIdentity)

    expect(computeResolvedProfileHashV1(profileIdentity)).toBe(
      '6ed26be0722b71f9acc217f213f79e3bcfab689219d0784dabaae63a701d9a7a',
    )
    expect(computeAuthorityContentHashV1(authorityIdentity)).toBe(
      'e3310ce067f2dbf997f43f23cd0a722e9cb17cfa0d51d1a8f651be6295eba19d',
    )
  })

  it('keeps raster, package coordinates, and provenance out of authority identity', () => {
    const rasterProfile: ResolvedProfileIdentityV1 = {
      ...structuredClone(profileIdentity),
      capabilities: ['game-data', 'raster-assets'],
      base: {
        ...profileIdentity.base,
        packageHash: 'a'.repeat(64),
      },
      files: [
        ...structuredClone(profileIdentity.files),
        {
          descriptor: {
            path: 'images/core.png',
            mediaType: 'image/png',
            size: 8,
            sha256: 'b'.repeat(64),
          },
          provenance: {
            packageHash: 'a'.repeat(64),
            operation: 'snapshot',
            sourcePath: 'images/core.png',
          },
        },
      ],
    }
    const original = computeResolvedProfileIdentitiesV1(profileIdentity)
    const raster = computeResolvedProfileIdentitiesV1(rasterProfile)

    expect(raster.resolvedProfileHash).not.toBe(original.resolvedProfileHash)
    expect(raster.authorityContentHash).toBe(original.authorityContentHash)
    expect(raster.authorityContentIdentity).toEqual(original.authorityContentIdentity)
  })

  it('returns a detached authority projection instead of aliases into the profile', () => {
    const projection = projectAuthorityContentIdentityV1(profileIdentity)
    const expected = structuredClone(projection) as AuthorityContentIdentityV1

    ;(projection.compatibility as { engineAbi: string }).engineAbi = 'tampered/v1'
    ;(projection.files[0] as { sha256: string }).sha256 = 'f'.repeat(64)

    expect(profileIdentity.compatibility.engineAbi).toBe('rvb-engine/v1')
    expect(profileIdentity.files[0].descriptor.sha256).toBe(FILE_SHA256)
    expect(expected.compatibility.engineAbi).toBe('rvb-engine/v1')
  })
})
