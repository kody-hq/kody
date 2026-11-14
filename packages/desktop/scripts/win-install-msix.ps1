# Installs the built MSIX the way a sideloading user does, then verifies its
# signatures and publisher. Exports the signer certificate for the release and
# writes the installed package identity for the smoke test and App Installer.
$ErrorActionPreference = 'Stop'
$output = 'artifacts/desktop'
$msix = Get-Item "$output/Kody-*-win-$env:KODY_DESKTOP_ARCH.msix"
$signer = (Get-AuthenticodeSignature $msix.FullName).SignerCertificate
if (-not $signer) { throw "Unsigned package: $($msix.Name)" }
$certificate = Join-Path $output 'Kody-win-signer.cer'
[IO.File]::WriteAllBytes($certificate, $signer.Export('Cert'))

# Sideloaded self-signed packages need only Trusted People, the documented
# user step; a publicly trusted signer already chains to a root.
Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
Add-AppxPackage -Path $msix.FullName
$package = Get-AppxPackage -Name KodyCodes.Kody
if (-not $package) { throw 'The MSIX did not install.' }

if ($signer.Subject -eq $signer.Issuer) {
  Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
}
$bundle = if ($env:KODY_DESKTOP_ARCH -eq 'arm64') { 'win-arm64-unpacked' } else { 'win-unpacked' }
foreach ($file in @($msix, (Get-Item "$output/$bundle/Kody.exe"))) {
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne 'Valid') { throw "Invalid signature: $($file.Name) $($signature.StatusMessage)" }
  $env:ACTUAL_PUBLISHER_SUBJECT = $signature.SignerCertificate.Subject
  node packages/desktop/scripts/verify-windows-publisher.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Windows publisher verification failed.' }
}

$executable = (Get-AppxPackageManifest $package).Package.Applications.Application.Executable
@(
  "KODY_MSIX_EXECUTABLE=$(Join-Path $package.InstallLocation $executable)"
  "PACKAGE_NAME=$($package.Name)"
  "PACKAGE_PUBLISHER=$($package.Publisher)"
  "PACKAGE_VERSION=$($package.Version)"
  "PACKAGE_ARCH=$($package.Architecture)"
) | Add-Content -Path $env:GITHUB_ENV
