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
		window: {
			show: () => call('window-show'),
			hide: () => call('window-hide'),
			focus: () => call('window-focus'),
			setFloating: (floating) => call('window-floating', floating),
			open: (path, options) => call('window-open', path, options),
		},
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
