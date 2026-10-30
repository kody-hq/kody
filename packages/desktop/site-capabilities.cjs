// The live website and shell ship independently. Only remove native window
// chrome when the server advertises the navigation UI that replaces it.
async function supportsIntegratedTitlebar(origin, fetchPage) {
	try {
		const response = await fetchPage(`${origin}/login`, {
			method: 'HEAD',
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
			headers: { Accept: 'text/html' },
		})
		return (
			response.ok && response.headers.get('X-Kody-Desktop-Navigation') === '1'
		)
	} catch {
		return false
	}
}
module.exports = { supportsIntegratedTitlebar }
