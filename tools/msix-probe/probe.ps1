$ErrorActionPreference = 'Continue'
$arch = $env:PROBE_ARCH
$out = Resolve-Path artifacts/desktop
$v1 = $env:PROBE_VERSION_1
$v2 = $env:PROBE_VERSION_2
function Section($t) { Write-Host "`n===== $t =====" }
function Clean { Get-AppxPackage KodyCodes.Kody | Remove-AppxPackage -ErrorAction SilentlyContinue }
function Installed { $p = Get-AppxPackage KodyCodes.Kody; if ($p) { "$($p.PackageFullName) v$($p.Version) loc=$($p.InstallLocation)" } else { 'not installed' } }

Section 'Artifacts'
Get-ChildItem $out | Format-Table Name, Length
$msix = Join-Path $out "Kody-$v1-win-$arch.msix"
Get-AuthenticodeSignature $msix | Format-List Status, StatusMessage, SignerCertificate

Section 'Direct Add-AppxPackage -Path (local file)'
Clean
try { Add-AppxPackage -Path $msix -ErrorAction Stop; "OK: $(Installed)" } catch { "FAIL: $_" }
$pkg = Get-AppxPackage KodyCodes.Kody
if ($pkg) {
  Section 'Manifest'
  Get-Content (Join-Path $pkg.InstallLocation 'AppxManifest.xml') | Select-Object -First 60
  Section 'Playwright launch from InstallLocation'
  node tools/msix-probe/smoke.cjs (Join-Path $pkg.InstallLocation 'app\Kody.exe') 2>&1 | Select-Object -Last 15
  Section 'AUMID launch'
  Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!Kody"
  Start-Sleep 25
  Get-Process Kody -ErrorAction SilentlyContinue | Select-Object Id, Path, MainWindowTitle | Format-Table -AutoSize
  Get-Process Kody -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 3
}

foreach ($proto in @('http', 'https')) {
  $port = if ($proto -eq 'http') { 8080 } else { 8443 }
  foreach ($variant in @('redirect')) {
    Section "AppInstaller $proto $variant"
    Clean
    $url = "${proto}://localhost:$port/$variant/Kody-win-$arch.appinstaller"
    try { Add-AppxPackage -AppInstallerFile $url -ErrorAction Stop; "OK: $(Installed)" } catch { "FAIL: $_" }
    try { Get-AppxPackageAutoUpdateSettings -PackageFamilyName (Get-AppxPackage KodyCodes.Kody).PackageFamilyName -ErrorAction Stop | Format-List } catch { "no autoupdate settings: $_" }
  }
}

Section 'Update via launch (https redirect)'
Clean
Invoke-WebRequest "http://localhost:8080/__set?v=$v1" -UseBasicParsing | Out-Null
try { Add-AppxPackage -AppInstallerFile "https://localhost:8443/redirect/Kody-win-$arch.appinstaller" -ErrorAction Stop; "OK: $(Installed)" } catch { "FAIL: $_" }
Invoke-WebRequest "http://localhost:8080/__set?v=$v2" -UseBasicParsing | Out-Null
$pkg = Get-AppxPackage KodyCodes.Kody
if ($pkg) {
  for ($i = 0; $i -lt 3; $i++) {
    Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!Kody"
    Start-Sleep 45
    Get-Process Kody -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 15
    "after launch $i : $(Installed)"
  }
  Section 'Re-run Add-AppxPackage -AppInstallerFile for update'
  try { Add-AppxPackage -AppInstallerFile "https://localhost:8443/redirect/Kody-win-$arch.appinstaller" -ErrorAction Stop; "OK: $(Installed)" } catch { "FAIL: $_" }
}
Section 'Server log'
((Invoke-WebRequest 'http://localhost:8080/__log' -UseBasicParsing).Content -split "`n" | Where-Object { $_ -notmatch 'msix range=bytes' }) -join "`n"
try { Get-AppxPackageAutoUpdateSettings -PackageFamilyName (Get-AppxPackage KodyCodes.Kody).PackageFamilyName | Format-List } catch { "$_" }
Section 'AppInstaller event log'
Get-WinEvent -LogName 'Microsoft-Windows-AppxDeploymentServer/Operational' -MaxEvents 40 -ErrorAction SilentlyContinue | Where-Object LevelDisplayName -ne 'Information' | Select-Object TimeCreated, Id, Message | Format-List
Get-WinEvent -LogName 'Microsoft-Windows-AppxPackaging/Operational' -MaxEvents 20 -ErrorAction SilentlyContinue | Where-Object LevelDisplayName -ne 'Information' | Select-Object TimeCreated, Id, Message | Format-List
