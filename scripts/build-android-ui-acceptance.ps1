param(
    [string]$JavaPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_HOME,
    [ValidateRange(26, 2100000000)][int]$VersionCode = 26
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $JavaPath) { $JavaPath = Join-Path $env:ProgramFiles 'Android/Android Studio/jbr' }
if (-not $SdkPath) { $SdkPath = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $JavaPath 'bin/java.exe'))) { throw 'Set -JavaPath to JDK 21 or newer.' }
if (-not (Test-Path -LiteralPath $SdkPath)) { throw 'Set -SdkPath to the installed Android SDK.' }
$previousJava = $env:JAVA_HOME
$previousSdk = $env:ANDROID_HOME
$previousVersion = $env:RVB_ANDROID_VERSION_NAME
$previousVersionCode = $env:RVB_ANDROID_VERSION_CODE
Push-Location $taskRoot
try {
    $env:JAVA_HOME = $JavaPath
    $env:ANDROID_HOME = $SdkPath
    $env:RVB_ANDROID_VERSION_NAME = (Get-Content -Raw package.json | ConvertFrom-Json).version
    $env:RVB_ANDROID_VERSION_CODE = if ($previousVersionCode) { [string][Math]::Max($VersionCode, [int]$previousVersionCode) } else { [string]$VersionCode }
    # Capacitor needs an entry file while generating plugin projects. The UI
    # variant overrides the generated public assets with the current full set.
    Copy-Item -LiteralPath 'data/pages/index.html' -Destination 'android-client/www/index.html'
    $capacitorSettings = [IO.File]::ReadAllBytes((Join-Path $taskRoot 'android/capacitor.settings.gradle'))
    $capacitorBuild = [IO.File]::ReadAllBytes((Join-Path $taskRoot 'android/app/capacitor.build.gradle'))
    try {
        & npx.cmd cap update android
        if ($LASTEXITCODE -ne 0) { throw 'Capacitor update failed.' }
    } finally {
        [IO.File]::WriteAllBytes((Join-Path $taskRoot 'android/capacitor.settings.gradle'), $capacitorSettings)
        [IO.File]::WriteAllBytes((Join-Path $taskRoot 'android/app/capacitor.build.gradle'), $capacitorBuild)
    }
    & ./android/gradlew.bat -p android assembleUiAcceptance --console=plain --max-workers=1
    if ($LASTEXITCODE -ne 0) { throw 'Android UI acceptance build failed.' }
    $output = Join-Path $taskRoot 'dist/android-ui-acceptance'
    New-Item -ItemType Directory -Force $output | Out-Null
    Copy-Item -LiteralPath 'android/app/build/outputs/apk/uiAcceptance/app-uiAcceptance.apk' -Destination (Join-Path $output 'RedVsBlue-RED199-UI-Acceptance.apk')
    $apkPath = Join-Path $output 'RedVsBlue-RED199-UI-Acceptance.apk'
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $apkStream = [IO.File]::OpenRead($apkPath)
    try {
        $digest = ([BitConverter]::ToString($sha256.ComputeHash($apkStream))).Replace('-', '').ToLowerInvariant()
        Write-Output "APK: $apkPath"
        Write-Output "SHA256: $digest"
    } finally { $apkStream.Dispose(); $sha256.Dispose() }
} finally {
    Pop-Location
    $env:JAVA_HOME = $previousJava
    $env:ANDROID_HOME = $previousSdk
    $env:RVB_ANDROID_VERSION_NAME = $previousVersion
    $env:RVB_ANDROID_VERSION_CODE = $previousVersionCode
}
