const { contextBridge, ipcRenderer, webFrame } = require('electron')

// Installed package app windows only. The main process answers whether this
// document may have the bridge (main frame, the app's exact origin, flag on)
// and checks the sender again on every call, so a frame or a page that
// navigated away cannot use it.
const allowed =
	process.isMainFrame &&
	ipcRenderer.sendSync('kody:package-app-bridge', location.origin) === true

function call(action, ...args) {
	return ipcRenderer.invoke('kody:package-app', action, ...args)
}

if (allowed) {
	contextBridge.exposeInMainWorld('kodyDesktopApp', {
		version: 1,
		available: true,
		permissions: {
			query: (kind) => call('permission-query', kind),
			request: (kind) => call('permission-request', kind),
		},
		badge: { set: (count) => call('badge', count) },
		menuBar: {
			set: (path, options) => call('menu-bar-set', path, options?.tooltip),
			remove: () => call('menu-bar-remove'),
		},
		shortcuts: {
			register: (accelerator) => call('shortcut-register', accelerator),
			unregister: (accelerator) => call('shortcut-unregister', accelerator),
			onPress: (callback) => {
				const listener = (_event, accelerator) => callback(accelerator)
				ipcRenderer.on('kody:package-app-shortcut', listener)
				return () =>
					ipcRenderer.removeListener('kody:package-app-shortcut', listener)
			},
		},
		startAtLogin: { set: (on) => call('start-at-login', on) },
		window: {
			show: () => call('window-show'),
			hide: () => call('window-hide'),
			focus: () => call('window-focus'),
			setFloating: (floating) => call('window-floating', floating),
			open: (path, options) => call('window-open', path, options),
		},
	})
	// A menu-bar page sizes its popover with
	// <meta name="kody-menubar-size" content="360x480">.
	window.addEventListener('DOMContentLoaded', () => {
		const size = document
			.querySelector('meta[name="kody-menubar-size"]')
			?.getAttribute('content')
		if (size) void call('menu-bar-size', size)
	})
	// `new Notification(title, { data: { path } })` focuses the app and opens
	// that path when clicked.
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== location.origin) return
		const path = event.data?.kodyDesktopAppNotificationPath
		if (typeof path === 'string') void call('open-path', path)
	})
	void webFrame.executeJavaScript(`(() => {
		const Base = window.Notification
		if (!Base) return
		class Notification extends Base {
			constructor(title, options) {
				super(title, options)
				const path = options?.data?.path
				if (typeof path === 'string')
					this.addEventListener('click', () =>
						window.postMessage({ kodyDesktopAppNotificationPath: path }, location.origin),
					)
			}
		}
		window.Notification = Notification
	})()`)
}
