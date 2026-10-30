const { isExternalUrl } = require('./navigation.cjs')

function attachWindowNavigation(
	window,
	{ appOrigin, clipboard, shell, integratedTitlebar = false },
) {
	const contents = window.webContents
	function trustedUrl(url) {
		try {
			return new URL(url).origin === appOrigin
		} catch {
			return false
		}
	}
	function snapshot() {
		return {
			platform: process.platform,
			integratedTitlebar,
			canGoBack: contents.navigationHistory.canGoBack(),
			canGoForward: contents.navigationHistory.canGoForward(),
			url: contents.getURL(),
			fullscreen: window.isFullScreen(),
		}
	}
	function publish() {
		if (!contents.isDestroyed() && trustedUrl(contents.getURL()))
			contents.send('kody:navigation-state', snapshot())
	}
	for (const event of [
		'did-navigate',
		'did-navigate-in-page',
		'did-finish-load',
	])
		contents.on(event, publish)
	window.on('enter-full-screen', publish)
	window.on('leave-full-screen', publish)
	async function command(action) {
		const history = contents.navigationHistory
		switch (action) {
			case 'state':
				return snapshot()
			case 'back':
				if (history.canGoBack()) history.goBack()
				break
			case 'forward':
				if (history.canGoForward()) history.goForward()
				break
			case 'home':
				await contents.loadURL(`${appOrigin}/account`)
				break
			case 'copy-address':
				clipboard.writeText(contents.getURL())
				break
			case 'open-browser': {
				const url = contents.getURL()
				if (trustedUrl(url) || isExternalUrl(url)) await shell.openExternal(url)
				break
			}
			default:
				throw new Error('Unknown navigation action.')
		}
		return snapshot()
	}
	function accepts(event) {
		return (
			event.sender === contents &&
			event.senderFrame === contents.mainFrame &&
			trustedUrl(event.senderFrame.url)
		)
	}
	return { accepts, command }
}
module.exports = { attachWindowNavigation }
