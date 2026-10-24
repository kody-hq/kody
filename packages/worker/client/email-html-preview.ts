const fullHtmlDocumentPattern = /^<!DOCTYPE\s+html\b/i
const htmlRootPattern = /^<html[\s>]/i

/**
 * `sandbox` value for the email HTML preview iframe. Popups are allowed (and
 * escape the sandbox) so links open in a normal new tab; scripts, forms and
 * same-origin access stay blocked.
 */
export const emailHtmlPreviewSandbox =
	'allow-popups allow-popups-to-escape-sandbox'

/**
 * Head tags for the preview document: no referrer on any request, and every
 * link opens in a new tab. A `_blank` target without an opener-granting `rel`
 * gets noopener semantics, and no-referrer covers noreferrer.
 */
const previewHeadTags =
	'<meta name="referrer" content="no-referrer"><base target="_blank">'

/** Strip script blocks from inbound email HTML before sandboxed preview. */
export function stripDangerousEmailHtml(html: string) {
	return html.replaceAll(
		/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
		'',
	)
}

/**
 * Drop `target` from links so the injected `<base target="_blank">` applies to
 * every link (no in-frame or named-window navigation), and drop `rel` values
 * that would hand the new tab a reference back to the preview.
 */
function normalizeEmailLinks(html: string) {
	return html.replaceAll(/<(?:a|area)\b[^>]*>/gi, (tag) =>
		tag
			.replaceAll(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')
			.replaceAll(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, ''),
	)
}

function isFullHtmlDocument(html: string) {
	const trimmed = html.trimStart()
	return fullHtmlDocumentPattern.test(trimmed) || htmlRootPattern.test(trimmed)
}

function injectPreviewHeadTags(html: string) {
	if (/<head[\s>]/i.test(html)) {
		return html.replace(/<head([^>]*)>/i, `<head$1>${previewHeadTags}`)
	}
	if (/<html[\s>]/i.test(html)) {
		return html.replace(/<html([^>]*)>/i, `<html$1>${previewHeadTags}`)
	}
	if (/<!DOCTYPE[^>]*>/i.test(html)) {
		return html.replace(
			/<!DOCTYPE[^>]*>/i,
			(doctype) => `${doctype}${previewHeadTags}`,
		)
	}
	return `${previewHeadTags}${html}`
}

function wrapEmailHtmlFragment(html: string) {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${previewHeadTags}
<style>
html, body { margin: 0; padding: 0; }
body {
	padding: 1rem;
	word-wrap: break-word;
	overflow-wrap: anywhere;
	color: #101010;
	font-family: ui-sans-serif, system-ui, sans-serif;
}
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

/** Build srcdoc HTML for a sandboxed admin email preview iframe. */
export function buildAdminEmailHtmlPreviewDocument(htmlBody: string) {
	const sanitized = normalizeEmailLinks(stripDangerousEmailHtml(htmlBody))
	if (isFullHtmlDocument(sanitized)) {
		return injectPreviewHeadTags(sanitized)
	}
	return wrapEmailHtmlFragment(sanitized)
}
