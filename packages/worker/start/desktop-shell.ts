export type DesktopExecutionState = {
	name: string
	platform: string
	supported: boolean
	signedIn: boolean
	busy: boolean
	commandsEnabled: boolean | null
	hasSetup: boolean
	contextId: string | null
	running: boolean
	needsVerification: boolean
	blocked: boolean
	onboardingSeen: boolean
	cliReady: boolean
	error: string | null
}
export type DesktopExecutionBridge = {
	commandsStatus: () => Promise<DesktopExecutionState>
	enableCommands: () => Promise<DesktopExecutionState>
	disableCommands: () => Promise<DesktopExecutionState>
	forgetSetup: () => Promise<DesktopExecutionState>
	getState: () => Promise<DesktopExecutionState>
	signIn: () => Promise<DesktopExecutionState>
	connect: (name: string) => Promise<DesktopExecutionState>
	start: () => Promise<DesktopExecutionState>
	stop: () => Promise<DesktopExecutionState>
	dismissOnboarding: () => Promise<DesktopExecutionState>
	completeOnboarding: () => Promise<DesktopExecutionState>
}
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
	execution?: DesktopExecutionBridge
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
