const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { attachWindowNavigation } = require('../window-navigation.cjs')
function fixture() {
	const contents = new EventEmitter()
	const frame = { url: 'https://kody.codes/account' }
	const calls = []
	Object.assign(contents, {
		mainFrame: frame,
		getURL: () => frame.url,
		isDestroyed: () => false,
		send: (...args) => calls.push(args),
		loadURL: async (url) => {
			calls.push(['load', url])
		},
		navigationHistory: {
			canGoBack: () => true,
			canGoForward: () => false,
			goBack: () => calls.push(['back']),
			goForward: () => calls.push(['forward']),
		},
	})
	const window = new EventEmitter()
	Object.assign(window, { webContents: contents, isFullScreen: () => false })
	const navigation = attachWindowNavigation(window, {
		appOrigin: 'https://kody.codes',
		clipboard: { writeText: (url) => calls.push(['copy', url]) },
		shell: { openExternal: async (url) => calls.push(['open', url]) },
	})
	return { navigation, contents, frame, calls }
}
test('navigation IPC accepts only the owning window main frame on the exact app origin', () => {
	const { navigation, contents, frame } = fixture()
	assert.equal(
		navigation.accepts({ sender: contents, senderFrame: frame }),
		true,
	)
	assert.equal(
		navigation.accepts({ sender: contents, senderFrame: { url: frame.url } }),
		false,
	)
	assert.equal(navigation.accepts({ sender: {}, senderFrame: frame }), false)
	frame.url = 'https://github.com/login'
	assert.equal(
		navigation.accepts({ sender: contents, senderFrame: frame }),
		false,
	)
})
test('history, home, and address actions stay scoped to the owning window', async () => {
	const { navigation, calls, contents } = fixture()
	await navigation.command('back')
	await navigation.command('forward')
	await navigation.command('home')
	await navigation.command('copy-address')
	assert.deepEqual(calls, [
		['back'],
		['load', 'https://kody.codes/account'],
		['copy', 'https://kody.codes/account'],
	])
	contents.emit('did-navigate-in-page')
	assert.equal(calls.at(-1)[0], 'kody:navigation-state')
	assert.equal(calls.at(-1)[1].canGoBack, true)
	await assert.rejects(navigation.command('execute'), /Unknown navigation/)
})
