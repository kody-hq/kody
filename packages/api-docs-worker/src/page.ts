/**
 * Scalar API reference shell. Spec URL is same-origin `/openapi.json`, which
 * this worker proxies from the live API so `api.kody.codes` never serves HTML.
 *
 * Pin the CDN package so a floating `latest` cannot break production docs.
 */
const scalarCdnUrl =
	'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.3/dist/browser/standalone.js'
const scalarCdnIntegrity =
	'sha384-HWi/QCSPi64AQ0xBXFGDk+7gmvZ4hJ/7sZMIXqWVz6Ikb6+Cxej/hWKaomOStyFb'

export function renderApiDocsPage(input: { title: string; specPath: string }) {
	const title = escapeHtml(input.title)
	const specPath = escapeHtml(input.specPath)
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${title}</title>
	<meta name="description" content="Interactive OpenAPI reference for the Kody HTTP API." />
	<link rel="icon" href="https://kody.codes/favicon.ico" />
	<style>
		html, body { margin: 0; padding: 0; min-height: 100%; }
	</style>
</head>
<body>
	<script
		id="api-reference"
		data-url="${specPath}"
		data-configuration='{"hideClientButton":true,"hideDarkModeToggle":false,"telemetry":false}'
	></script>
	<script src="${scalarCdnUrl}" integrity="${scalarCdnIntegrity}" crossorigin="anonymous"></script>
</body>
</html>
`
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}
