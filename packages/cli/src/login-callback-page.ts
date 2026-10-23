/**
 * Self-contained OAuth callback HTML for `kody login`.
 * Tokens and CSS match kody.codes (`kody-hq/kody` packages/worker/public/styles.css).
 * Inline CSS + inline SVG only — no external network requests from localhost.
 */
import {
	kodyMarkPngDataUri,
	kodyPatternWebpDataUri,
} from './login-callback-assets.js'

export type LoginCallbackAccount = {
	/** Prefer display name; fall back to email or username in the renderer. */
	displayName?: string
	email?: string
	username?: string
}

export type LoginCallbackSuccess = {
	kind: 'success'
	org?: string
	account?: LoginCallbackAccount
}

export type LoginCallbackErrorKind =
	| 'denied'
	| 'state_mismatch'
	| 'expired'
	| 'failed'
	| 'save_failed'

export type LoginCallbackError = {
	kind: 'error'
	error: LoginCallbackErrorKind
}

export type LoginCallbackPage = LoginCallbackSuccess | LoginCallbackError

const errorCopy: Record<
	LoginCallbackErrorKind,
	{ title: string; body: string }
> = {
	denied: {
		title: 'Sign-in cancelled',
		body: 'You denied access in the browser. Nothing was saved.',
	},
	state_mismatch: {
		title: 'Sign-in session mismatch',
		body: 'This login link did not match the request from your terminal (or it was reused).',
	},
	expired: {
		title: 'Sign-in expired',
		body: 'This login session timed out before it finished.',
	},
	failed: {
		title: 'Sign-in failed',
		body: 'Kody could not finish signing the CLI in.',
	},
	save_failed: {
		title: 'Approved, but not saved',
		body: 'You approved the connection, but the Kody CLI could not save your sign-in on this computer. Your terminal shows what went wrong and how to fix it.',
	},
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function accountLabel(account: LoginCallbackAccount): string | undefined {
	const display = account.displayName?.trim()
	const email = account.email?.trim()
	const username = account.username?.trim()
	if (display && email && display !== email) return `${display} (${email})`
	if (display) return display
	if (email) return email
	if (username) return username
	return undefined
}

function brandMarkSvg(): string {
	// Official koala mark (PNG) embedded inside SVG so the page stays
	// CSS + SVG with no external image requests.
	return `<svg class="mark" xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40" role="img" aria-label="Kody">
  <image href="${kodyMarkPngDataUri}" width="40" height="40" preserveAspectRatio="xMidYMid meet"/>
</svg>`
}

function statusIconSvg(kind: 'success' | 'error'): string {
	if (kind === 'success') {
		return `<svg class="status-icon" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
  <circle cx="14" cy="14" r="14" fill="var(--color-primary)"/>
  <path d="M8.2 14.2l3.4 3.4 8.2-8.2" fill="none" stroke="var(--color-on-primary)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
	}
	return `<svg class="status-icon" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
  <circle cx="14" cy="14" r="14" fill="var(--color-danger)"/>
  <path d="M9.5 9.5l9 9M18.5 9.5l-9 9" fill="none" stroke="var(--color-on-danger)" stroke-width="2.4" stroke-linecap="round"/>
</svg>`
}

function pageCss(): string {
	// Color / type / pattern tokens copied from kody.codes public/styles.css
	// (kody-hq/kody). Pattern is the official shirt tile, inlined as a mask.
	return `:root {
  color-scheme: light dark;
  --color-primary: oklch(0.54 0.18 145);
  --color-primary-hover: oklch(0.48 0.17 145);
  --color-on-primary: oklch(1 0 0);
  --color-primary-text: oklch(0.455 0.17 145);
  --color-background: oklch(0.93 0.004 250);
  --color-surface: oklch(0.975 0.002 250);
  --color-text: oklch(0.22 0.012 260);
  --color-text-muted: oklch(0.44 0.014 260);
  --color-border: oklch(0.84 0.008 250);
  --color-danger: oklch(0.535 0.19 25);
  --color-on-danger: oklch(0.985 0.005 25);
  --color-primary-dark: oklch(0.72 0.205 145);
  --color-primary-hover-dark: oklch(0.78 0.21 145);
  --color-on-primary-dark: oklch(0.2 0.05 148);
  --color-primary-text-dark: oklch(0.75 0.2 145);
  --color-background-dark: oklch(0.19 0.008 255);
  --color-surface-dark: oklch(0.235 0.01 255);
  --color-text-dark: oklch(0.945 0.005 250);
  --color-text-muted-dark: oklch(0.72 0.01 255);
  --color-border-dark: oklch(0.33 0.01 255);
  --color-danger-dark: oklch(0.75 0.16 25);
  --color-on-danger-dark: oklch(0.2 0.05 25);
  --font-display: 'Bricolage Grotesque', system-ui, sans-serif;
  --font-body: 'Wix Madefor Text', system-ui, sans-serif;
  --radius-card: 14px;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --kody-pattern: url('${kodyPatternWebpDataUri}');
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --color-primary: var(--color-primary-dark);
    --color-primary-hover: var(--color-primary-hover-dark);
    --color-on-primary: var(--color-on-primary-dark);
    --color-primary-text: var(--color-primary-text-dark);
    --color-background: var(--color-background-dark);
    --color-surface: var(--color-surface-dark);
    --color-text: var(--color-text-dark);
    --color-text-muted: var(--color-text-muted-dark);
    --color-border: var(--color-border-dark);
    --color-danger: var(--color-danger-dark);
    --color-on-danger: var(--color-on-danger-dark);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  min-height: 100%;
  font-family: var(--font-body);
  font-size: 1.0625rem;
  line-height: 1.62;
  color: var(--color-text);
  background: var(--color-background);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.page {
  position: relative;
  isolation: isolate;
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: clamp(1.5rem, 4vw, 3rem);
}
.page::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 0;
  background: radial-gradient(
    ellipse 55% 50% at 50% 42%,
    oklch(from var(--color-text) l c h / 0.055),
    transparent 72%
  );
  mask-image: var(--kody-pattern);
  mask-position: center;
  mask-size: 220px;
  mask-repeat: repeat;
  -webkit-mask-image: var(--kody-pattern);
  -webkit-mask-position: center;
  -webkit-mask-size: 220px;
  -webkit-mask-repeat: repeat;
  pointer-events: none;
}
.panel {
  width: min(100%, 28rem);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  padding: 1.75rem 1.6rem 1.55rem;
  box-shadow: 0 10px 28px oklch(from var(--color-text) l c h / 0.06);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font: 700 1.2rem/1 var(--font-display);
  letter-spacing: -0.01em;
  color: var(--color-text);
  text-decoration: none;
}
.mark { display: block; border-radius: 10px; background: #111; }
.status {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  margin-top: 1.45rem;
}
.status-icon { flex: 0 0 auto; margin-top: 0.15rem; }
h1 {
  margin: 0;
  font: 800 1.55rem/1.15 var(--font-display);
  letter-spacing: -0.02em;
  text-wrap: balance;
}
.lead {
  margin: 0.55rem 0 0;
  color: var(--color-text-muted);
  text-wrap: pretty;
}
.facts {
  list-style: none;
  margin: 1.15rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.55rem;
}
.facts li {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.55rem 0.75rem;
  border-radius: 10px;
  background: color-mix(in oklch, var(--color-primary) 7%, transparent);
}
.facts .label {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.facts .value {
  font-family: var(--font-display);
  font-weight: 650;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.next {
  margin: 1.2rem 0 0;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 0.95rem;
}
.next code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.9em;
  color: var(--color-primary-text);
  background: color-mix(in oklch, var(--color-primary) 10%, transparent);
  padding: 0.12rem 0.35rem;
  border-radius: 0.35rem;
}
@media (prefers-reduced-motion: no-preference) {
  .panel {
    animation: rise 420ms var(--ease-out) both;
  }
  .status-icon {
    animation: pop 480ms var(--ease-out) 80ms both;
  }
}
@keyframes rise {
  from { opacity: 0; translate: 0 12px; }
  to { opacity: 1; translate: 0 0; }
}
@keyframes pop {
  from { opacity: 0; scale: 0.84; }
  to { opacity: 1; scale: 1; }
}`
}

function closeScript(): string {
	// Browsers only allow window.close() for script-opened windows; try anyway.
	return `<script>
(function () {
  function attempt() {
    try { window.close(); } catch (_) {}
  }
  attempt();
  setTimeout(attempt, 120);
})();
</script>`
}

function renderSuccess(page: LoginCallbackSuccess): string {
	const org = page.org?.trim()
	const account = page.account ? accountLabel(page.account) : undefined
	const facts: string[] = []
	if (org) {
		facts.push(
			`<li><span class="label">Org</span><span class="value">${escapeHtml(org)}</span></li>`,
		)
	}
	if (account) {
		facts.push(
			`<li><span class="label">Account</span><span class="value">${escapeHtml(account)}</span></li>`,
		)
	}
	const factsHtml =
		facts.length > 0 ? `<ul class="facts">${facts.join('')}</ul>` : ''
	const lead = org
		? `Kody CLI is signed in to <strong>${escapeHtml(org)}</strong>.`
		: 'Kody CLI is signed in.'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light dark"/>
<title>Signed in · Kody CLI</title>
<style>${pageCss()}</style>
</head>
<body>
<main class="page">
  <section class="panel" data-state="success">
    <div class="brand">${brandMarkSvg()}<span>Kody</span></div>
    <div class="status">
      ${statusIconSvg('success')}
      <div>
        <h1>You're signed in</h1>
        <p class="lead">${lead}</p>
      </div>
    </div>
    ${factsHtml}
    <p class="next">You can close this tab and return to your terminal.</p>
  </section>
</main>
${closeScript()}
</body>
</html>`
}

function renderError(page: LoginCallbackError): string {
	const copy = errorCopy[page.error]
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light dark"/>
<title>${escapeHtml(copy.title)} · Kody CLI</title>
<style>${pageCss()}</style>
</head>
<body>
<main class="page">
  <section class="panel" data-state="error" data-error="${escapeHtml(page.error)}">
    <div class="brand">${brandMarkSvg()}<span>Kody</span></div>
    <div class="status">
      ${statusIconSvg('error')}
      <div>
        <h1>${escapeHtml(copy.title)}</h1>
        <p class="lead">${escapeHtml(copy.body)}</p>
      </div>
    </div>
    <p class="next">${
			page.error === 'save_failed'
				? 'Return to your terminal, follow the fix it shows, then run <code>kody login</code> again.'
				: 'Return to your terminal and run <code>kody login</code> to try again.'
		}</p>
  </section>
</main>
${closeScript()}
</body>
</html>`
}

/** Build the localhost callback HTML. Never includes codes or tokens. */
export function renderLoginCallbackPage(page: LoginCallbackPage): string {
	if (page.kind === 'success') return renderSuccess(page)
	return renderError(page)
}

/** Map OAuth `error` query values to a designed error state. */
export function loginCallbackErrorFromOAuthError(
	error: string,
): LoginCallbackErrorKind {
	const normalized = error.trim().toLowerCase()
	if (
		normalized === 'access_denied' ||
		normalized === 'denied' ||
		normalized === 'consent_required'
	) {
		return 'denied'
	}
	if (
		normalized === 'expired' ||
		normalized === 'expired_token' ||
		normalized === 'invalid_grant' ||
		normalized.includes('expired')
	) {
		return 'expired'
	}
	if (
		normalized === 'state_mismatch' ||
		normalized === 'invalid_request' ||
		normalized === 'invalid_state'
	) {
		return 'state_mismatch'
	}
	return 'failed'
}
