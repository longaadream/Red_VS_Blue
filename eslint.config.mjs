import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
  {
    // Match the file scope where eslint-config-next registers these plugins.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      '@next/next/no-img-element': 'error',
      'import/no-anonymous-default-export': 'error',
    },
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // These scripts navigate standalone HTML documents, not Next.js routes.
    files: ['data/pages/js/**/*.js', 'android-client/www/js/**/*.js'],
    rules: { '@next/next/no-location-assign-relative-destination': 'off' },
  },
  {
    // Unlike TypeScript, these audited browser scripts need ESLint name checks.
    files: [
      'android-client/www/js/ws-client.js',
      'data/pages/js/developer-tools/match-trace.js',
      'data/pages/js/developer-tools/replay-viewer.js',
      'data/pages/js/tutorial/tutorial-runtime.js',
    ],
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['data/pages/js/developer-tools/replay-viewer.js'],
    // Loaded by replay.html before the viewer script.
    languageOptions: {
      globals: { BattleViewModel: 'readonly', BattleRenderer3D: 'readonly', RvBDeveloperTools: 'readonly' },
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'output/**',
    'dist/**',
    '**/dist/**',
    '_client-colyseus/**',
    '_client-embedded-postgres/**',
    '_client-node/**',
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
    'data/pages/js/game-engine.js',
    // Vendored browser distribution, identified by its Colyseus license header.
    'data/pages/js/colyseus-sdk.js',
    '**/*.min.js',
    'app/tailwind-compiled.css',
    'lib/generated/**',
    'logs/**',
    'next-env.d.ts',
  ]),
])
