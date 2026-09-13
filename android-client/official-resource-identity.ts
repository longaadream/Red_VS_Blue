import type { resolveAndroidProfile } from '../lib/content-pipeline/android/resolve'

export type OfficialResourceIdentity = { publisherKeyId:string;version:string;engineAbi:string;contentAbi:string }
type Profile=ReturnType<typeof resolveAndroidProfile>['profile']
function resourceVersion(profile:Profile){return profile.patches.length?profile.patches[profile.patches.length-1].version:profile.base.version}
export function isNewerOfficialResource(version:string,parent:Profile){
  const parse=(v:string)=>{if(!/^\d+\.\d+\.\d+$/.test(v))throw Error('资源版本格式无效');const parts=v.split('.').map(Number);if(parts.some(n=>!Number.isSafeInteger(n)))throw Error('资源版本超出范围');return parts}
  const left=parse(version),right=parse(resourceVersion(parent))
  for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]
  return false
}

/** Call only after the shared resolver has verified the archive's signature and content. */
export function assertOfficialResourceIdentity(profile:ReturnType<typeof resolveAndroidProfile>['profile'],publisherKeyId:string,trusted:string[],expected:OfficialResourceIdentity) {
  const version=resourceVersion(profile)
  if(publisherKeyId!==expected.publisherKeyId||!trusted.includes(publisherKeyId)||version!==expected.version||profile.compatibility.engineAbi!==expected.engineAbi||profile.compatibility.contentAbi!==expected.contentAbi)throw Error('已签名资源与发布清单不匹配，未保存候选版本')
}
