const config = require('./electron-builder.cjs')
module.exports = {
	...config,
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
