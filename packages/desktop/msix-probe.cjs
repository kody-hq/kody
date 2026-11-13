const config = require('./electron-builder.cjs')
module.exports = {
	...config,
	toolsets: { winCodeSign: '1.1.0' },
	win: {
		...config.win,
		target: ['appx'],
		signtoolOptions: {
			publisherName: 'Kody Desktop CI',
			signingHashAlgorithms: ['sha256'],
		},
	},
	appx: {
		identityName: 'KodyCodes.Kody',
		applicationId: 'Kody',
		publisher: 'CN=Kody Desktop CI',
		publisherDisplayName: 'Kody',
		displayName: 'Kody',
		artifactName: 'Kody-${version}-win-${arch}.msix',
	},
}
