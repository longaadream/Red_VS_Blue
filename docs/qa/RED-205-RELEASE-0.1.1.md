# RED-205: Windows / Android 0.1.1

## Contract

- Goal: release the merged room responsiveness, connection and update fixes as Windows and Android 0.1.1, as requested by the owner.
- Base: main, 6f13402fab0bee91e3cefdf1c3e011e040f6cac9 (freshly fetched).
- Scope: package version, Android public demo build wiring and packaging verification. Reuse the existing release signer; do not change keys.
- Allowed paths: package.json, package-lock.json, android/app/build.gradle, android/app/src/uiAcceptance/AndroidManifest.xml, scripts/stage-android-ui-acceptance.mjs, generated browser bundles, release tests and this report.
- Non-goals: gameplay changes, other UI issue changes, QA app identity replacement, data migration.
- Risk: High (distribution). Owner authorized this release; source PRs still require owner merge.
- Acceptance: both artifacts share a committed source and version; APK is non-debuggable, formal package, existing certificate, increasing versionCode; manifests and hashes match; Windows package passes integrity checks; Android delta reconstructs the target APK exactly.
- Checks: main baseline, synchronized-release / Android artifact / delta tests, changed Gradle and staging review, APK signature and source verification, packaged smoke when an Android device is available.
- Rollback: withdraw a faulty release and restore the previous latest feed; installed Android clients require a corrected build with higher versionCode, never force a downgrade. Keep existing signing identity and user data.

## Notes

Public demo wiring is integrated from the other workspace's inspected build-only changes. That workspace remains untouched. Preview (.hostqa / startupqa) and formal clients have different identities and must not be silently cross-updated.
