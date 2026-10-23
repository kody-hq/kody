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
	'Kody could not open your browser automatically. Copy the link above into your browser to continue.\n'
