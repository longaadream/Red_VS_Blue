import { describe,it,expect } from 'vitest'
import { appendAndroidPack,resolveAndroidProfile,type AndroidPackInput } from '@/lib/content-pipeline/android/resolve'
import { computePackageHashV1,sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import { deriveEd25519PublicKeyV1,derivePublisherKeyIdV1,signPackageHashV1 } from '@/lib/content-pipeline/core/signature'
import type { PackManifestV1 } from '@/lib/content-pipeline/contracts'

const key=new Uint8Array(32).fill(42) // public test fixture only, never a release key
const keyId=derivePublisherKeyIdV1(deriveEd25519PublicKeyV1(key))
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v))
function pack(kind:'snapshot'|'patch',parent?:string):AndroidPackInput{
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,1])
  const file={path:kind==='snapshot'?'images/example.png':'images/payload/example.png',size:bytes.length,sha256:sha256HexV1(bytes),mediaType:'image/png' as const}
  const common={schemaVersion:'rvb-pack/v1' as const,packageId:kind==='snapshot'?'test.snapshot':'test.patch',displayName:'Android test',version:'1.0.0',publisher:{id:'test.publisher',keyId},compatibility:{engineAbi:'rvb-engine/v1',contentAbi:'rvb-content/v1'},capabilities:['raster-assets' as const],files:[file]}
  const manifest:PackManifestV1=kind==='snapshot'?{...common,kind}:{...common,kind,parentProfileHash:parent!,operations:[{op:'add',targetPath:'images/other.png',sourcePath:file.path}]}
  return{id:kind,source:{manifestBytes:encode(manifest),signatureBytes:encode(signPackageHashV1(computePackageHashV1(manifest),key)),entries:[{path:file.path,bytes}]}}
}
describe('Android content uses the shared v1 resolver',()=>{
  it('imports signed snapshots and preserves authority identity for a raster patch',()=>{
    const base=pack('snapshot'), initial=resolveAndroidProfile(base,[],[])
    const incoming=pack('patch',initial.profile.resolvedProfileHash)
    const next=appendAndroidPack(base,[],incoming,[keyId])
    expect(next.profile.authorityContentHash).toBe(initial.profile.authorityContentHash)
    expect(next.profile.resolvedProfileHash).not.toBe(initial.profile.resolvedProfileHash)
    expect(next.chain).toEqual(['snapshot','patch'])
    expect(initial.profile.files).toHaveLength(1)
  })
  it('refuses untrusted, missing and corrupted signatures',()=>{
    const base=pack('snapshot'),external=pack('snapshot')
    expect(()=>resolveAndroidProfile(base,[external],[])).toThrow('尚未受信任')
    external.source={...external.source,signatureBytes:null}
    expect(()=>resolveAndroidProfile(base,[external],[keyId])).toThrow('缺少签名')
    const damaged=pack('snapshot');damaged.source.entries[0].bytes[8]=7
    expect(()=>resolveAndroidProfile(base,[damaged],[keyId])).toThrow()
  })
  it('rejects mismatched patch parents without modifying stable source',()=>{
    const base=pack('snapshot'),before=base.source.entries[0].bytes.slice()
    expect(()=>appendAndroidPack(base,[],pack('patch','0'.repeat(64)),[keyId])).toThrow()
    expect(base.source.entries[0].bytes).toEqual(before)
  })
  it('a separate object cannot claim bundled policy using the same id',()=>{
    const base=pack('snapshot'),external={...pack('snapshot'),id:base.id}
    expect(()=>resolveAndroidProfile(base,[external],[])).toThrow('尚未受信任')
  })
})
