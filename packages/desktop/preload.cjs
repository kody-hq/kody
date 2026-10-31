const { contextBridge, ipcRenderer } = require('electron')
const origin = process.argv
	.find((arg) => arg.startsWith('--kody-app-origin='))
	?.slice('--kody-app-origin='.length)

// Only the main Kody document gets this bridge, never an embedded frame or a
// sign-in provider. Navigation does not expose CLI, filesystem, or shell APIs.
if (process.isMainFrame && location.origin === origin) {
	contextBridge.exposeInMainWorld('kodyDesktop', {
		version: 1,
		...(process.argv.includes('--kody-browser-login')
			? {
					authentication: {
						signIn: async (mode) => {
							const result = await ipcRenderer.invoke(
								'kody:authentication',
								mode,
							)
							if (result?.error) throw new Error(result.error)
						},
						cancel: () => ipcRenderer.invoke('kody:authentication', 'cancel'),
					},
				}
			: {}),
		navigation: {
			getState: () => ipcRenderer.invoke('kody:navigation', 'state'),
			back: () => ipcRenderer.invoke('kody:navigation', 'back'),
			forward: () => ipcRenderer.invoke('kody:navigation', 'forward'),
			home: () => ipcRenderer.invoke('kody:navigation', 'home'),
			copyAddress: () => ipcRenderer.invoke('kody:navigation', 'copy-address'),
			openInBrowser: () =>
				ipcRenderer.invoke('kody:navigation', 'open-browser'),
			onChange: (callback) => {
				const listener = (_event, state) => callback(state)
				ipcRenderer.on('kody:navigation-state', listener)
				return () =>
					ipcRenderer.removeListener('kody:navigation-state', listener)
			},
		},
	})
}
