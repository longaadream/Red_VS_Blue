import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    '**/dist/**',
    '_client-stage/**',
    '_server-stage/**',
    'android/.gradle/**',
    'android/.idea/**',
    'android/build/**',
    'android/app/build/**',
    'android/app/src/main/assets/game_assets/**',
    'android/app/src/main/assets/public/**',
    'android/app/src/main/assets/mobile-server.js',
    'android/app/src/main/assets/capacitor.config.json',
    'android/app/src/main/assets/capacitor.plugins.json',
    'android/app/capacitor-cordova-android-plugins/**',
    'android-client/www/data/**',
    'android-client/www/images/**',
    'android-client/www/*.html',
    'android-client/www/game-engine.js',
    'android-client/www/js/crypto-lib.js',
    'android-client/www/js/game-engine.js',
    '**/*.min.js',
    'app/tailwind-compiled.css',
    'lib/generated/**',
    'logs/**',
    'next-env.d.ts',
  ]),
])
