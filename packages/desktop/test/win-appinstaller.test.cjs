const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	appInstallerXml,
	assertAppInstaller,
} = require('../scripts/win-appinstaller.cjs')

const identity = {
	name: 'KodyCodes.Kody',
	publisher: 'CN="Kody & Co", O=Kody',
	version: '0.1.74',
	arch: 'arm64',
}
const assets = ['Kody-0.1.74-win-arm64.msix']

test('App Installer files update from the stable latest URL and install the versioned package', () => {
	const xml = appInstallerXml(identity)
	assert.match(
		xml,
		/Uri="https:\/\/github\.com\/kody-hq\/kody-desktop\/releases\/latest\/download\/Kody-win-arm64\.appinstaller"/,
	)
	assert.match(
		xml,
		/Uri="https:\/\/github\.com\/kody-hq\/kody-desktop\/releases\/download\/v0\.1\.74\/Kody-0\.1\.74-win-arm64\.msix"/,
	)
	assert.match(xml, /Publisher="CN=&quot;Kody &amp; Co&quot;, O=Kody"/)
	assert.match(xml, /<OnLaunch HoursBetweenUpdateChecks="0" \/>/)
	assert.doesNotThrow(() =>
		assertAppInstaller('Kody-win-arm64.appinstaller', xml, '0.1.74', assets),
	)
})

test('publication rejects App Installer files that point anywhere else', () => {
	const xml = appInstallerXml(identity)
	assert.throws(
		() =>
			assertAppInstaller('Kody-win-x64.appinstaller', xml, '0.1.74', assets),
		/stable latest URL/,
	)
	assert.throws(
		() =>
			assertAppInstaller('Kody-win-arm64.appinstaller', xml, '0.1.75', assets),
		/is for 0\.1\.74\.0, not 0\.1\.75/,
	)
	assert.throws(
		() => assertAppInstaller('Kody-win-arm64.appinstaller', xml, '0.1.74', []),
		/missing asset Kody-0\.1\.74-win-arm64\.msix/,
	)
	assert.throws(
		() =>
			assertAppInstaller(
				'Kody-win-arm64.appinstaller',
				xml.replace(
					/ProcessorArchitecture="arm64"/,
					'ProcessorArchitecture="x64"',
				),
				'0.1.74',
				assets,
			),
		/another version or arch/,
	)
	assert.throws(
		() => appInstallerXml({ ...identity, publisher: '' }),
		/identity/,
	)
})
