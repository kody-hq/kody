const { contextBridge, ipcRenderer } = require('electron')
const origin = process.argv
	.find((arg) => arg.startsWith('--kody-app-origin='))
	?.slice('--kody-app-origin='.length)

// Only the main Kody document gets this bridge, never an embedded frame or a
// sign-in provider. Machine controls expose fixed actions, never CLI arguments,
// filesystem access, tokens, or shell commands.
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
		execution: {
			commandsStatus: () =>
				ipcRenderer.invoke('kody:execution', 'commands-status'),
			enableCommands: () => ipcRenderer.invoke('kody:execution', 'commands-on'),
			disableCommands: () =>
				ipcRenderer.invoke('kody:execution', 'commands-off'),
			getState: () => ipcRenderer.invoke('kody:execution', 'state'),
			forgetSetup: () => ipcRenderer.invoke('kody:execution', 'forget'),
			signIn: () => ipcRenderer.invoke('kody:execution', 'sign-in'),
			connect: (name) => ipcRenderer.invoke('kody:execution', 'connect', name),
			start: () => ipcRenderer.invoke('kody:execution', 'start'),
			stop: () => ipcRenderer.invoke('kody:execution', 'stop'),
			dismissOnboarding: () => ipcRenderer.invoke('kody:execution', 'dismiss'),
			completeOnboarding: () =>
				ipcRenderer.invoke('kody:execution', 'complete'),
		},
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
