// Entry point for the browser crypto bundle.
// Bundled by scripts/build-crypto-lib.js → android-client/www/js/crypto-lib.js

export {
  getPublicKeyAsync,
  signAsync,
  verifyAsync,
} from '@noble/ed25519'

export {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
} from '@scure/bip39'

export { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'
