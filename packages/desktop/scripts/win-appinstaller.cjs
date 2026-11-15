const { writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { windowsAppInstallerName } = require('./release-plan.cjs')

// App Installer keeps Windows installs current: it re-reads the stable
// latest-release URL on launch and in the background, then installs the
// versioned package it names. The package identity must match the MSIX.
const releases = 'https://github.com/kody-hq/kody-desktop/releases'
const namespace = 'http://schemas.microsoft.com/appx/appinstaller/2018'

function packageVersion(version) {
	return `${version}.0`
}
function appInstallerUri(arch) {
	return `${releases}/latest/download/${windowsAppInstallerName(arch)}`
}
function packageUri(version, arch) {
	return `${releases}/download/v${version}/Kody-${version}-win-${arch}.msix`
}
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function escapeXml(value) {
	return value.replace(/[&<>"]/g, (character) => entities[character])
}
function unescapeXml(value) {
	return Object.entries(entities).reduceRight(
		(text, [character, entity]) => text.replaceAll(entity, character),
		value,
	)
}

function appInstallerXml({ name, publisher, version, arch }) {
	if (!name || !publisher) throw new Error('Missing Windows package identity')
	return `<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="${namespace}" Version="${packageVersion(version)}" Uri="${appInstallerUri(arch)}">
  <MainPackage Name="${escapeXml(name)}" Publisher="${escapeXml(publisher)}" Version="${packageVersion(version)}" ProcessorArchitecture="${arch}" Uri="${packageUri(version, arch)}" />
  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="0" />
    <AutomaticBackgroundTask />
  </UpdateSettings>
</AppInstaller>
`
}

function attributes(text, element) {
	const tag = text.match(new RegExp(`<${element}\\s([^>]*)>`))?.[1]
	if (!tag) throw new Error(`App Installer file has no ${element}`)
	return Object.fromEntries(
		[...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [
			key,
			unescapeXml(value),
		]),
	)
}

// Publication refuses an App Installer file that would send installs to
// another release, architecture, or a package missing from this release.
function assertAppInstaller(name, text, version, assetNames) {
	const arch = name.match(/^Kody-win-(x64|arm64)\.appinstaller$/)?.[1]
	if (!arch) throw new Error(`${name} is not a Windows App Installer file`)
	const root = attributes(text, 'AppInstaller')
	const main = attributes(text, 'MainPackage')
	if (root.xmlns !== namespace)
		throw new Error(`${name} uses an unsupported schema`)
	if (root.Uri !== appInstallerUri(arch))
		throw new Error(`${name} does not update from its stable latest URL`)
	if (root.Version !== packageVersion(version))
		throw new Error(`${name} is for ${root.Version}, not ${version}`)
	if (
		main.Version !== packageVersion(version) ||
		main.ProcessorArchitecture !== arch
	)
		throw new Error(`${name} names a package for another version or arch`)
	if (!main.Name || !main.Publisher)
		throw new Error(`${name} has no package identity`)
	if (main.Uri !== packageUri(version, arch))
		throw new Error(`${name} points at ${main.Uri}`)
	const msix = main.Uri.slice(main.Uri.lastIndexOf('/') + 1)
	if (!assetNames.includes(msix))
		throw new Error(`${name} points at missing asset ${msix}`)
}

if (require.main === module) {
	const { version } = require('../package.json')
	const arch = process.env.PACKAGE_ARCH?.toLowerCase()
	if (arch !== process.arch)
		throw new Error(`Installed package is ${arch}, not ${process.arch}`)
	if (process.env.PACKAGE_VERSION !== packageVersion(version))
		throw new Error(
			`Installed package is ${process.env.PACKAGE_VERSION}, not ${version}`,
		)
	const output = resolve(
		process.argv[2] ?? join(__dirname, '../../../artifacts/desktop'),
	)
	writeFileSync(
		join(output, windowsAppInstallerName(arch)),
		appInstallerXml({
			name: process.env.PACKAGE_NAME,
			publisher: process.env.PACKAGE_PUBLISHER,
			version,
			arch,
		}),
	)
}
module.exports = { appInstallerXml, assertAppInstaller }
