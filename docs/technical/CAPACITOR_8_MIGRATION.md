# Capacitor 8 Android build requirements

RED-20 upgrades `@capacitor/cli`, `@capacitor/core`, and
`@capacitor/android` to 8.5.0. The Android project now requires:

- JDK 21
- Android Studio Otter (2025.2.1) or newer
- Android SDK platform 36 and matching build tools
- Android Gradle Plugin 8.13.0 and Gradle 8.14.3

The supported Android range is API 24 and above. Android API 22 and 23 are no
longer supported by the mobile client.

## Local validation

Set `JAVA_HOME` to a JDK 21 installation, then run from the repository root:

```powershell
npm.cmd ci
npm.cmd run build:android
```

`build:android` builds the current `UiAcceptanceActivity` shell, including the
native host, update bridge and full staged resources. Install
`dist/android-ui-acceptance/RedVsBlue-RED199-UI-Acceptance.apk` on an API 24+
device and verify that the launcher activity opens and game assets load.
This isolated acceptance app uses package ID `com.redvsblue.client.uiqa`.
Do not run `assembleDebug`: that variant uses the obsolete `MainActivity` shell.
Public packages use `scripts/build-android-release.ps1` and `assembleDemo`.
Acceptance versionCode defaults to 26; pass `-VersionCode` to the PowerShell
script for later candidates. An existing higher environment override is retained.

The Gradle project deliberately does not set `org.gradle.java.home`; this keeps
the required JDK 21 selection explicit in the local environment or Android
Studio configuration.
