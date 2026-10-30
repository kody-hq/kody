export type DesktopNavigationState = {
	platform: string
	integratedTitlebar: boolean
	canGoBack: boolean
	canGoForward: boolean
	url: string
	fullscreen: boolean
}
export type DesktopShell = {
	version: 1
	authentication?: {
		signIn: (mode: 'login' | 'signup') => Promise<void>
		cancel: () => Promise<void>
	}
	navigation: {
		getState: () => Promise<DesktopNavigationState>
		back: () => Promise<DesktopNavigationState>
		forward: () => Promise<DesktopNavigationState>
		home: () => Promise<DesktopNavigationState>
		copyAddress: () => Promise<DesktopNavigationState>
		openInBrowser: () => Promise<DesktopNavigationState>
		onChange: (callback: (state: DesktopNavigationState) => void) => () => void
	}
}
declare global {
	interface Window {
		kodyDesktop?: DesktopShell
	}
}
