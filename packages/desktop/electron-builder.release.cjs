const config = require('./electron-builder.cjs')
const azure =
	process.platform === 'win32' &&
	process.env.KODY_WINDOWS_SIGNING_PROVIDER === 'azure'
if (
	process.platform === 'win32' &&
	!['certificate', 'azure'].includes(
		process.env.KODY_WINDOWS_SIGNING_PROVIDER || 'certificate',
	)
)
	throw new Error('Unsupported Windows signing provider')
const required =
	process.platform === 'darwin'
		? [
				'APPLE_API_KEY',
				'APPLE_API_KEY_ID',
				'APPLE_API_ISSUER',
				...(process.env.CSC_LINK ? ['CSC_KEY_PASSWORD'] : []),
			]
		: process.platform === 'win32'
			? azure
				? [
						'AZURE_TENANT_ID',
						'AZURE_CLIENT_ID',
						'AZURE_CLIENT_SECRET',
						'KODY_AZURE_ENDPOINT',
						'KODY_AZURE_ACCOUNT',
						'KODY_AZURE_PROFILE',
						'KODY_WINDOWS_PUBLISHER',
					]
				: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'KODY_WINDOWS_PUBLISHER']
			: []
for (const name of required) {
	if (!process.env[name]) throw new Error(`Missing release credential: ${name}`)
}
if (
	process.platform === 'darwin' &&
	!process.env.CSC_LINK &&
	!process.env.CSC_NAME
) {
	throw new Error('Missing release credential: CSC_LINK or CSC_NAME')
}
module.exports = {
	...config,
	// Architecture channels keep parallel Windows and Mac jobs from
	// replacing each other's update manifests.
	publish: {
		provider: 'github',
		owner: 'kody-hq',
		repo: 'kody-desktop',
		channel: `latest-${process.arch}`,
		tagNamePrefix: 'v',
		releaseType: 'draft',
	},
	forceCodeSigning: process.platform !== 'linux',
	mac: {
		...config.mac,
		identity: undefined,
		hardenedRuntime: true,
		notarize: true,
	},
	win: {
		...config.win,
		verifyUpdateCodeSignature: true,
		...(azure
			? {
					azureSignOptions: {
						publisherName: process.env.KODY_WINDOWS_PUBLISHER,
						endpoint: process.env.KODY_AZURE_ENDPOINT,
						codeSigningAccountName: process.env.KODY_AZURE_ACCOUNT,
						certificateProfileName: process.env.KODY_AZURE_PROFILE,
					},
				}
			: {
					signtoolOptions: {
						publisherName: process.env.KODY_WINDOWS_PUBLISHER,
					},
				}),
	},
}
