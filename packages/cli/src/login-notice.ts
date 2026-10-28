/**
 * Terminal copy for `kody login`. The sign-in URL is printed on every run,
 * even when opening the browser appears to work, because "opened" only means
 * the system opener started: no window may actually appear.
 */
export function formatLoginUrlNotice(input: {
	url: URL
	openBrowser: boolean
}): string {
	const lead = input.openBrowser
		? 'Opening the Kody sign-in page in your browser.\nIf no browser window appears, copy this link into your browser:'
		: 'Open this link in your browser to sign in to Kody:'
	return `${lead}\n\n  ${input.url.href}\n\nWaiting for you to finish signing in…\n`
}

export const loginBrowserOpenFailedNotice =
	'Kody could not open your browser automatically. Copy the link above into your browser to continue.\nIf that browser is on another machine, press Ctrl+C and run `kody login --device` instead.\n'

/**
 * Why the browser flow probably cannot finish here: its callback listens on
 * 127.0.0.1 of this machine, which a browser elsewhere cannot reach.
 */
export function detectHeadlessLoginReason(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): 'ssh' | 'no_display' | null {
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return 'ssh'
	if (
		platform !== 'darwin' &&
		platform !== 'win32' &&
		!env.DISPLAY &&
		!env.WAYLAND_DISPLAY
	) {
		return 'no_display'
	}
	return null
}

export function formatDeviceLoginSuggestion(
	reason: 'ssh' | 'no_display',
): string {
	const why =
		reason === 'ssh'
			? 'This looks like an SSH session'
			: 'No display was found on this machine'
	return `${why}, so a browser here may not be able to finish the sign-in.\nIf it can't, press Ctrl+C and run \`kody login --device\` to sign in from any other device.\n\n`
}

/** Terminal copy for `kody login --device`. */
export function formatDeviceLoginNotice(input: {
	userCode: string
	verificationUri: string
	verificationUriComplete?: string
	expiresIn: number
}): string {
	const minutes = Math.max(1, Math.round(input.expiresIn / 60))
	const direct = input.verificationUriComplete
		? `\nOr open this link, which fills in the code for you:\n\n  ${input.verificationUriComplete}\n`
		: ''
	return `To sign in, open this page on any device:\n\n  ${input.verificationUri}\n\nand enter the code:\n\n  ${input.userCode}\n${direct}\nOnly approve it if the page shows this same code. The code expires in ${minutes} minutes.\nWaiting for approval…\n`
}

/** Shared success lines for `kody login` and `kody login --device`. */
export function formatLoginSuccess(result: {
	credentials: { mcpUrl: string; org?: string }
	org?: string
	account?: { email?: string; displayName?: string }
	backendKind: 'keyring' | 'file'
	backendPath?: string
}): string {
	const orgLabel = result.org
		? ` as org ${result.org}`
		: result.credentials.org
			? ` as org ${result.credentials.org}`
			: ''
	const accountLabel = result.account?.email
		? ` (${result.account.email})`
		: result.account?.displayName
			? ` (${result.account.displayName})`
			: ''
	const lines = [
		`Logged in to ${result.credentials.mcpUrl}${orgLabel}${accountLabel}.\n`,
	]
	if (result.backendKind === 'file' && result.backendPath) {
		lines.push(
			`OS keychain was unavailable; credentials saved at ${result.backendPath} (mode 0600).\n`,
		)
	} else {
		lines.push('Credentials stored in the OS keychain.\n')
	}
	return lines.join('')
}
