// Isolated public test fixtures. Never use this deterministic signing key for releases.
import fs from 'node:fs'
import path from 'node:path'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'dist/android-update-qa')
fs.mkdirSync(dir,{recursive:true})
await build({stdin:{contents:`export {createBundledBasePackInputV1,getBundledBaseProfileV1} from './lib/content-pipeline/runtime/bundled-base';export {signPackageHashV1,deriveEd25519PublicKeyV1,derivePublisherKeyIdV1} from './lib/content-pipeline/core/signature';export {computePackageHashV1,sha256HexV1} from './lib/content-pipeline/core/hash';export {appendAndroidPack} from './lib/content-pipeline/android/resolve';`,resolveDir:root,loader:'ts'},outfile:path.join(dir,'fixtures.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external'})
const require=createRequire(import.meta.url),api=require(path.join(dir,'fixtures.cjs')),Zip=require('adm-zip')
const secret=new Uint8Array(32).fill(42),keyId=api.derivePublisherKeyIdV1(api.deriveEd25519PublicKeyV1(secret))
const base={id:'base',source:api.createBundledBasePackInputV1(root).source},initial=api.getBundledBaseProfileV1(root).profile
const encode=v=>new TextEncoder().encode(JSON.stringify(v))
function pack(name,parent,game){
 const bytes=game?encode({androidAcceptance:true}):new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=','base64'))
 const file={path:game?'data/android-acceptance.json':'images/android-acceptance.png',mediaType:game?'application/json':'image/png',size:bytes.length,sha256:api.sha256HexV1(bytes)}
 const manifest={schemaVersion:'rvb-pack/v1',kind:'patch',packageId:'qa.'+name,version:'1.0.0',displayName:'Android QA '+name,publisher:{id:'qa.android',keyId},compatibility:initial.compatibility,capabilities:[game?'game-data':'raster-assets'],files:[file],parentProfileHash:parent,operations:[{op:'add',targetPath:file.path,sourcePath:file.path}]}
 const signature=api.signPackageHashV1(api.computePackageHashV1(manifest),secret),source={manifestBytes:encode(manifest),signatureBytes:encode(signature),entries:[{path:file.path,bytes}]}
 const zip=new Zip();zip.addFile('manifest.json',Buffer.from(source.manifestBytes));zip.addFile('signature.json',Buffer.from(source.signatureBytes));zip.addFile(file.path,Buffer.from(bytes));zip.writeZip(path.join(dir,name+'.zip'))
 return{id:name,source}
}
const raster=pack('raster',initial.resolvedProfileHash,false),rasterProfile=api.appendAndroidPack(base,[],raster,[keyId])
const game=pack('game',rasterProfile.profile.resolvedProfileHash,true),gameProfile=api.appendAndroidPack(base,[base,raster],game,[keyId])
const damaged=fs.readFileSync(path.join(dir,'raster.zip'));damaged[0]=0;fs.writeFileSync(path.join(dir,'broken.zip'),damaged.subarray(0,damaged.length-9))
fs.writeFileSync(path.join(dir,'expected.json'),JSON.stringify({base:initial,raster:rasterProfile.profile,game:gameProfile.profile,keyId},null,2))
fs.writeFileSync(path.join(dir,'distribution.json'),JSON.stringify({updateUrl:'https://10.0.2.2:19443/android-latest.json',trustedPublisherKeyIds:[keyId]}))
const python=process.env.RVB_PYTHON||'python'
execFileSync(python,['-c',`from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import datetime,ipaddress,pathlib
p=pathlib.Path(${JSON.stringify(dir)})
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'RVB isolated Android QA')])
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=1)).not_valid_after(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=3)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('10.0.2.2')),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256())
(p/'qa-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
(p/'qa-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))`],{stdio:'inherit'})
console.log('Generated isolated fixtures at '+dir)
