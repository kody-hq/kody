const { createHash } = require('node:crypto')
const mark = require('./kody-mark.cjs')

// Static copy only: request values (code, state, errors) never reach the page.
const pages = {
	success: {
		status: 200,
		tone: 'success',
		title: 'You’re signed in',
		body: 'Kody desktop is connected to your account. Head back to the Kody app to pick up where you left off.',
		hint: 'You can close this tab.',
	},
	failed: {
		status: 400,
		tone: 'error',
		title: 'Sign-in didn’t finish',
		body: 'Kody couldn’t complete sign-in. The request may have expired or been interrupted.',
		hint: 'Return to the Kody app and choose Sign in to try again.',
	},
	denied: {
		status: 400,
		tone: 'error',
		title: 'Sign-in was canceled',
		body: 'Kody desktop wasn’t given access to your account.',
		hint: 'Return to the Kody app and choose Sign in to try again.',
	},
	invalid: {
		status: 400,
		tone: 'error',
		title: 'This sign-in link isn’t valid',
		body: 'It doesn’t match the sign-in Kody started on this computer, or it was already used.',
		hint: 'Return to the Kody app and start sign-in again from there.',
	},
	busy: {
		status: 409,
		tone: 'info',
		title: 'Sign-in is already finishing',
		body: 'Kody is completing this sign-in in another tab.',
		hint: 'Return to the Kody app. You can close this tab.',
	},
}

const statusIcons = {
	success: '<path d="M7.5 12.5l3 3 6-7"/>',
	error: '<path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
	info: '<path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/>',
}

const styles = `
:root {
	color-scheme: light dark;
	--primary: oklch(0.54 0.18 145);
	--primary-text: oklch(0.455 0.17 145);
	--on-primary: oklch(1 0 0);
	--background: oklch(0.98 0.002 250);
	--surface: oklch(1 0 0);
	--text: oklch(0.22 0.012 260);
	--text-muted: oklch(0.44 0.014 260);
	--border: oklch(0.84 0.008 250);
	--danger: oklch(0.535 0.19 25);
	--on-danger: oklch(0.985 0.005 25);
	--lantern-glow: oklch(0.88 0.11 85 / 0.4);
	--shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
	--font-display: 'Bricolage Grotesque', system-ui, sans-serif;
	--font-body: 'Wix Madefor Text', system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
	:root {
		--primary: oklch(0.72 0.205 145);
		--primary-text: oklch(0.75 0.2 145);
		--on-primary: oklch(0.2 0.05 148);
		--background: oklch(0.19 0.008 255);
		--surface: oklch(0.235 0.01 255);
		--text: oklch(0.945 0.005 250);
		--text-muted: oklch(0.72 0.01 255);
		--border: oklch(0.33 0.01 255);
		--danger: oklch(0.75 0.16 25);
		--on-danger: oklch(0.2 0.05 25);
		--lantern-glow: oklch(0.8 0.13 80 / 0.18);
		--shadow: 0 4px 6px -1px rgb(0 0 0 / 0.35), 0 2px 4px -2px rgb(0 0 0 / 0.35);
	}
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
	margin: 0;
	display: grid;
	place-items: center;
	padding: clamp(1rem, 5vw, 3rem);
	background:
		radial-gradient(60rem 30rem at 50% -10%, var(--lantern-glow), transparent 70%),
		var(--background);
	color: var(--text);
	font: 400 1rem/1.62 var(--font-body);
	-webkit-font-smoothing: antialiased;
}
main {
	width: min(100%, 440px);
	display: flex;
	flex-direction: column;
	gap: 1.75rem;
}
.brand {
	display: inline-flex;
	align-items: center;
	align-self: center;
	gap: 0.6rem;
	font: 700 1.25rem/1 var(--font-display);
	letter-spacing: -0.01em;
}
.brand svg { display: block; height: 34px; width: auto; }
.mark-solid { display: none; }
@media (prefers-color-scheme: dark) {
	.mark-outlined { display: none; }
	.mark-solid { display: inline; }
}
.card {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 14px;
	box-shadow: var(--shadow);
	padding: clamp(1.5rem, 5vw, 2.25rem);
	display: flex;
	flex-direction: column;
	gap: 1rem;
}
.icon {
	width: 3rem;
	height: 3rem;
	border-radius: 999px;
	display: grid;
	place-items: center;
	background: var(--primary);
	color: var(--on-primary);
}
.icon svg {
	width: 1.75rem;
	height: 1.75rem;
	fill: none;
	stroke: currentColor;
	stroke-width: 2.4;
	stroke-linecap: round;
	stroke-linejoin: round;
}
[data-tone='error'] .icon { background: var(--danger); color: var(--on-danger); }
[data-tone='info'] .icon { background: var(--border); color: var(--text); }
h1 {
	margin: 0.25rem 0 0;
	font: 760 clamp(1.75rem, 6vw, 2.2rem)/1.08 var(--font-display);
	letter-spacing: -0.025em;
	text-wrap: balance;
}
p { margin: 0; }
.body { color: var(--text-muted); }
.hint {
	margin-top: 0.25rem;
	padding: 0.75rem 1rem;
	border-radius: 0.5rem;
	border: 1px solid var(--border);
	font-weight: 500;
}
[data-tone='success'] .hint { border: 0; padding: 0; color: var(--primary-text); }
footer {
	text-align: center;
	font-size: 0.875rem;
	color: var(--text-muted);
}
`

const styleHash = createHash('sha256').update(styles).digest('base64')
const contentSecurityPolicy = [
	"default-src 'none'",
	`style-src 'sha256-${styleHash}'`,
	'img-src data:',
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ')

const markSvg = `<svg viewBox="${mark.viewBox}" aria-hidden="true" focusable="false"><g class="mark-outlined" fill="currentColor"><path fill-rule="evenodd" transform="${mark.transform}" d="${mark.ring}"/><path transform="${mark.transform}" d="${mark.leftEye}"/><path transform="${mark.transform}" d="${mark.rightEye}"/><path transform="${mark.transform}" d="${mark.nose}"/></g><path class="mark-solid" fill="currentColor" fill-rule="evenodd" transform="${mark.transform}" d="${mark.solid}"/></svg>`

const favicon = `data:image/svg+xml,${encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}"><path fill="#2f9e4f" fill-rule="evenodd" transform="${mark.transform}" d="${mark.solid}"/></svg>`,
)}`

function renderCallbackPage(kind) {
	const page = pages[kind]
	if (!page) throw new Error(`Unknown sign-in page: ${kind}`)
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${page.title} · Kody</title>
<link rel="icon" href="${favicon}">
<style>${styles}</style>
</head>
<body>
<main data-tone="${page.tone}">
<div class="brand">${markSvg}<span>Kody</span></div>
<section class="card" aria-labelledby="title">
<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${statusIcons[page.tone]}</svg></div>
<h1 id="title">${page.title}</h1>
<p class="body">${page.body}</p>
<p class="hint">${page.hint}</p>
</section>
<footer>Kody desktop sign-in · served from this computer</footer>
</main>
</body>
</html>
`
	return {
		status: page.status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': contentSecurityPolicy,
			'X-Content-Type-Options': 'nosniff',
		},
		html,
	}
}

module.exports = { renderCallbackPage, callbackPageKinds: Object.keys(pages) }
