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
Set-Location android
.\gradlew.bat assembleDebug
```

`build:android` copies the generated web assets and runs `cap sync android`.
After `assembleDebug` succeeds, install the resulting debug APK on an API 24+
device or emulator and verify that the launcher activity opens and game assets
load.

The Gradle project deliberately does not set `org.gradle.java.home`; this keeps
the required JDK 21 selection explicit in the local environment or Android
Studio configuration.
