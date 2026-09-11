param(
    [string]$JavaPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_HOME
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $JavaPath) { $JavaPath = Join-Path $env:ProgramFiles 'Android/Android Studio/jbr' }
if (-not $SdkPath) { $SdkPath = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $JavaPath 'bin/java.exe'))) { throw 'Set -JavaPath to JDK 21 or newer.' }
if (-not (Test-Path -LiteralPath $SdkPath)) { throw 'Set -SdkPath to the installed Android SDK.' }
$previousJava = $env:JAVA_HOME
$previousSdk = $env:ANDROID_HOME
Push-Location $taskRoot
try {
    $env:JAVA_HOME = $JavaPath
    $env:ANDROID_HOME = $SdkPath
    # Capacitor needs an entry file while generating plugin projects. The UI
    # variant overrides the generated public assets with the current full set.
    Copy-Item -LiteralPath 'data/pages/index.html' -Destination 'android-client/www/index.html'
    & npx.cmd cap update android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor update failed.' }
    & ./android/gradlew.bat -p android assembleUiAcceptance --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android UI acceptance build failed.' }
    $output = Join-Path $taskRoot 'dist/android-ui-acceptance'
    New-Item -ItemType Directory -Force $output | Out-Null
    Copy-Item -LiteralPath 'android/app/build/outputs/apk/uiAcceptance/app-uiAcceptance.apk' -Destination (Join-Path $output 'RedVsBlue-RED199-UI-Acceptance.apk')
    Get-FileHash -Algorithm SHA256 (Join-Path $output 'RedVsBlue-RED199-UI-Acceptance.apk')
} finally {
    Pop-Location
    $env:JAVA_HOME = $previousJava
    $env:ANDROID_HOME = $previousSdk
}
