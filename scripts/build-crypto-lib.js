/**
 * build-crypto-lib.js
 *
 * Bundles @noble/ed25519 + @scure/bip39 into a single browser IIFE
 * at android-client/www/js/crypto-lib.js.
 *
 * Exposed global: window.CryptoLib
 *   .getPublicKeyAsync(privateKey: Uint8Array) → Uint8Array
 *   .signAsync(msg: Uint8Array, privateKey: Uint8Array) → Uint8Array
 *   .verifyAsync(sig, msg, pubKey) → boolean
 *   .generateMnemonic(wordlist) → string
 *   .validateMnemonic(mnemonic, wordlist) → boolean
 *   .mnemonicToSeed(mnemonic) → Promise<Uint8Array>
 *   .englishWordlist → string[]
 */

const path    = require('path')
const esbuild = require('esbuild')

const root    = path.join(__dirname, '..')
const outFile = path.join(root, 'android-client', 'www', 'js', 'crypto-lib.js')

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'crypto-lib-entry.js')],
    bundle:      true,
    platform:    'browser',
    format:      'iife',
    globalName:  'CryptoLib',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    outfile:  outFile,
    minify:   true,
    logLevel: 'warning',
  })

  const fs = require('fs')
  const kb = Math.round(fs.statSync(outFile).size / 1024)
  console.log(`[build-crypto-lib] Done → js/crypto-lib.js (${kb} KB)`)
}

main().catch(err => {
  console.error('[build-crypto-lib] Failed:', err.message || err)
  process.exit(1)
})
