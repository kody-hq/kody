const { appendFileSync, readFileSync } = require('node:fs')

const targets = [
	{ platform: 'mac', arch: 'arm64', runner: 'macos-15' },
	{ platform: 'mac', arch: 'x64', runner: 'macos-15-intel' },
	{ platform: 'win', arch: 'x64', runner: 'windows-latest' },
	{ platform: 'win', arch: 'arm64', runner: 'windows-11-arm' },
	{ platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04' },
	{ platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' },
]
function releasePlan(scope, env) {
	if (!['mac', 'all'].includes(scope))
		throw new Error('Choose mac or all release platforms.')
	const required = [
		'DESKTOP_MAC_CERTIFICATE_BASE64',
		'DESKTOP_MAC_CERTIFICATE_PASSWORD',
		'DESKTOP_APPLE_API_KEY_BASE64',
		'DESKTOP_APPLE_API_KEY_ID',
		'DESKTOP_APPLE_API_ISSUER',
		'DESKTOP_RELEASE_TOKEN',
	]
	if (scope === 'all') {
		const provider = env.DESKTOP_WINDOWS_SIGNING_PROVIDER || 'certificate'
		if (!['certificate', 'azure'].includes(provider))
			throw new Error('Unsupported Windows signing provider')
		required.push(
			'DESKTOP_WINDOWS_PUBLISHER',
			...(provider === 'azure'
				? [
						'DESKTOP_AZURE_TENANT_ID',
						'DESKTOP_AZURE_CLIENT_ID',
						'DESKTOP_AZURE_CLIENT_SECRET',
						'DESKTOP_AZURE_ENDPOINT',
						'DESKTOP_AZURE_ACCOUNT',
						'DESKTOP_AZURE_PROFILE',
					]
				: [
						'DESKTOP_WINDOWS_CERTIFICATE_BASE64',
						'DESKTOP_WINDOWS_CERTIFICATE_PASSWORD',
					]),
		)
	}
	return {
		matrix: {
			include: targets.filter(
				(target) => scope === 'all' || target.platform === 'mac',
			),
		},
		missing: required.filter((name) => !env[name]),
	}
}
function assertFeedCoverage(scope, assets) {
	if (!['mac', 'all'].includes(scope))
		throw new Error('Choose mac or all release platforms.')
	if (
		scope === 'mac' &&
		assets.some(
			(name) =>
				name.startsWith('latest-') &&
				name.endsWith('.yml') &&
				!name.endsWith('-mac.yml'),
		)
	) {
		throw new Error(
			'This feed already serves Windows or Linux. Choose all platforms to keep their update feeds available.',
		)
	}
}
if (require.main === module) {
	const scope = process.env.RELEASE_PLATFORMS || 'mac'
	if (process.argv.includes('--check-feed')) {
		const latest = JSON.parse(readFileSync(0, 'utf8'))
		assertFeedCoverage(
			scope,
			latest.assets.map((asset) => asset.name),
		)
	} else {
		const plan = releasePlan(scope, process.env)
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`matrix=${JSON.stringify(plan.matrix)}\n`,
		)
		if (plan.missing.length) {
			console.error(
				`Configure desktop-release environment: ${plan.missing.join(', ')}`,
			)
			process.exitCode = 1
		}
	}
}
module.exports = { releasePlan, assertFeedCoverage }
