# RED-205: Windows / Android 0.1.1

## Contract

- Goal: release the merged room responsiveness, connection and update fixes as Windows and Android 0.1.1, as requested by the owner.
- Base: main, 6f13402fab0bee91e3cefdf1c3e011e040f6cac9 (freshly fetched).
- Scope: package version, Android public demo build wiring and packaging verification. Reuse the existing release signer; do not change keys.
- Allowed paths: package.json, package-lock.json, android/app/build.gradle, android/app/src/uiAcceptance/AndroidManifest.xml, scripts/stage-android-ui-acceptance.mjs, scripts/synchronized-release.mjs (draft lookup discovered during upload), generated browser bundles, release tests and this report.
- Non-goals: gameplay changes, other UI issue changes, QA app identity replacement, data migration.
- Risk: High (distribution). Owner authorized this release; source PRs still require owner merge.
- Acceptance: both artifacts share a committed source and version; APK is non-debuggable, formal package, existing certificate, increasing versionCode; manifests and hashes match; Windows package passes integrity checks; Android delta reconstructs the target APK exactly.
- Checks: main baseline, synchronized-release / Android artifact / delta tests, changed Gradle and staging review, APK signature and source verification, packaged smoke when an Android device is available.
- Rollback: withdraw a faulty release and restore the previous latest feed; installed Android clients require a corrected build with higher versionCode, never force a downgrade. Keep existing signing identity and user data.

## Notes

Public demo wiring is integrated from the other workspace's inspected build-only changes. That workspace remains untouched. Preview (.hostqa / startupqa) and formal clients have different identities and must not be silently cross-updated.

## Verified candidate

- Both binaries built from `2a785e03e4613cef61fc0f90263279d10ea2863d`. Subsequent upload-tool/test/report changes do not change either binary.
- Windows: 232,979,974 bytes; SHA-256 `b793b198db91e5ce8812e95308ead0f9b87d3b6146f954618d2fadceb1616ad8`.
- Actual electron-updater 6.8.9 local Range transfer from official 0.1.0: 5,507,137 bytes including blockmaps, SHA-512 exact reconstruction (97.64% saving). This is not an Internet speed measurement; full download remains the fallback.
- Windows packaged room smoke with isolated installed resource pack: host + guest connected; ready 65 ms, ready/unready round trip 369 ms. No two-physical-machine VPN acceptance in this run.
- Android: 89,292,264 bytes; SHA-256 `45f901a4a328728fdc6887e50e788d7c46bf52e4da3d509cb5b9ffe021580fc7`; formal package, code 20, non-debug, both native ABIs, source proof and existing signer verified. Gradle lint/build and APK v2/v3 verification passed.
- APK patch 19→20: 5,243,981 bytes; actual Java client implementation reconstructed byte-exact APK on desktop JVM (94.13% saving). No connected Android device; system install and live Android networking remain manual acceptance.
- Compatibility: old signed code-19 APK has no `ApkDelta` class; its first update is full APK. Version 0.1.1 adds delta support for subsequent compatible releases. Do not describe the code-19 patch test as an old-client automatic delta upgrade.
- Upload initially reproduced HTTP 404 for a newly created draft's tag endpoint. A failing regression was added; lookup now uses authenticated release listing and retains draft/source/digest guards.
