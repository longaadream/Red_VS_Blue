param([Parameter(Mandatory=$true)][string]$SigningDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$signRoot = [IO.Path]::GetFullPath($SigningDirectory)
if (-not $env:JAVA_HOME -or -not $env:ANDROID_HOME -or -not $env:RVB_RELEASE_SOURCE_COMMIT) { throw 'JAVA_HOME, ANDROID_HOME and release source commit are required' }
if ($env:RVB_ANDROID_QA_CERT -or $env:RVB_ANDROID_DISTRIBUTION_CONFIG -or $env:RVB_ANDROID_HOST_ABI) { throw 'Remove Android QA/ABI overrides' }
Push-Location $projectRoot
try {
    # Only exact, owned outputs. Never delete through a junction or touch runtime/signing caches.
    $buildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'android/app/build'))
    foreach ($name in @('android','android/app','android/app/build')) {
        $item = Get-Item -LiteralPath (Join-Path $projectRoot $name) -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked Android build root is not allowed' }
    }
    if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
    New-Item -ItemType Directory -Force android-client/www | Out-Null
    Copy-Item -LiteralPath data/pages/index.html -Destination android-client/www/index.html
    # Capacitor may resolve node_modules junctions into machine-specific Gradle paths.
    # Preserve the checked-in, portable plugin references (the generated plugin project remains).
    $capacitorSettings = [IO.File]::ReadAllBytes((Join-Path $projectRoot 'android/capacitor.settings.gradle'))
    $capacitorBuild = [IO.File]::ReadAllBytes((Join-Path $projectRoot 'android/app/capacitor.build.gradle'))
    try {
        & node node_modules/@capacitor/cli/bin/capacitor update android
        if ($LASTEXITCODE -ne 0) { throw 'Capacitor update failed' }
    } finally {
        [IO.File]::WriteAllBytes((Join-Path $projectRoot 'android/capacitor.settings.gradle'), $capacitorSettings)
        [IO.File]::WriteAllBytes((Join-Path $projectRoot 'android/app/capacitor.build.gradle'), $capacitorBuild)
    }
    & ./android/gradlew.bat -p android assembleDemo --rerun-tasks --no-daemon --max-workers=1 --init-script ../scripts/android-release.init.gradle --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android public build failed' }
    $unsigned = Join-Path $buildRoot 'outputs/apk/demo/app-demo-unsigned.apk'
    $signed = Join-Path $buildRoot 'outputs/apk/demo/app-demo-signed.apk'
    $tool = Join-Path $env:ANDROID_HOME 'build-tools/35.0.0/lib/apksigner.jar'
    $java = Join-Path $env:JAVA_HOME 'bin/java.exe'
    $secure = Import-Clixml -LiteralPath (Join-Path $signRoot 'password.clixml')
    $env:RVB_RELEASE_SIGNING_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password
    & $java -jar $tool sign --ks (Join-Path $signRoot 'red-vs-blue-release.p12') --ks-key-alias red-vs-blue --ks-pass env:RVB_RELEASE_SIGNING_PASSWORD --out $signed $unsigned
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
    & $java -jar $tool verify --verbose $signed
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
} finally {
    Remove-Item Env:RVB_RELEASE_SIGNING_PASSWORD -ErrorAction SilentlyContinue
    Pop-Location
}
