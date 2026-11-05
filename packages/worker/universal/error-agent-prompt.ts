/**
 * Shared “Copy prompt for your agent” builder for website/email error
 * surfaces the user’s agent cannot already see (browser UI, OAuth/connect,
 * package apps, public error pages, failure emails). MCP/CLI/API paths that
 * already return the error stay out of this lane.
 *
 * Marker attribute for the inventory guard: `data-error-agent-prompt`.
 */

export const ERROR_AGENT_PROMPT_ATTR = 'data-error-agent-prompt'
export const ERROR_AGENT_PROMPT_TEST_ID = 'error-agent-prompt'
export const ERROR_AGENT_PROMPT_IDLE_LABEL = 'Copy prompt for your agent'

export type ErrorAgentPromptIds = {
	packageKodyId?: string | null
	packageName?: string | null
	repo?: string | null
	credentialName?: string | null
	credentialId?: string | null
	orgSlug?: string | null
	orgId?: string | null
	requestId?: string | null
	runId?: string | null
	connectionName?: string | null
	provider?: string | null
	path?: string | null
	username?: string | null
}

export type ErrorAgentPromptInput = {
	/** What the user was doing when the error happened. */
	activity: string
	/** Stable error code when we have one (never free-form secrets). */
	errorCode?: string | null
	/** User-visible error message (redacted before inclusion). */
	errorMessage: string
	ids?: ErrorAgentPromptIds
	/** Likely cause in plain language. */
	likelyCause?: string | null
	/** Concrete next steps for the agent. */
	nextSteps?: ReadonlyArray<string>
	/**
	 * Kody search/execute capability or guide entity names, e.g.
	 * `search({ entity: "guide:oauth" })`, `runGet`, `integrationList`.
	 */
	kodyTools?: ReadonlyArray<string>
	/** Doc paths or `guide:` entity ids. */
	docs?: ReadonlyArray<string>
}

const REDACTED = '[REDACTED]'

/** Query keys that must never appear with values. */
const secretQueryNames = [
	'access_token',
	'refresh_token',
	'id_token',
	'client_secret',
	'code',
	'token',
	'password',
	'api_key',
	'apikey',
	'session',
	'private_key',
	'privatekey',
]

const bearerPattern = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi
const jwtPattern =
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const skStyleKeyPattern =
	/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g
const longHexPattern = /\b[A-Fa-f0-9]{40,}\b/g
const mixedOpaqueTokenPattern =
	/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g

function redactSecretQueryParams(text: string) {
	let next = text
	for (const name of secretQueryNames) {
		const queryPattern = new RegExp(`([?&#]${name}=)([^&#\\s]*)`, 'gi')
		next = next.replace(queryPattern, `$1${REDACTED}`)
		const barePattern = new RegExp(`(\\b${name}=)([^&\\s]*)`, 'gi')
		next = next.replace(barePattern, `$1${REDACTED}`)
	}
	next = next.replace(/(client_secret\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`)
	next = next.replace(/(password\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`)
	return next
}

/**
 * Strip tokens, secrets, and opaque credential-shaped strings from prompt
 * text. Never include secret values, session cookies, or other users’ data.
 */
function redactPlainErrorAgentPromptText(text: string) {
	let next = text
	next = next.replace(bearerPattern, `Bearer ${REDACTED}`)
	next = next.replace(jwtPattern, REDACTED)
	next = next.replace(skStyleKeyPattern, REDACTED)
	next = redactSecretQueryParams(next)
	next = next.replace(longHexPattern, REDACTED)
	next = next.replace(mixedOpaqueTokenPattern, REDACTED)
	return next
}

/**
 * Strip tokens/secrets from prompt text. Also redacts a percent-decoded copy
 * so `access_token%3D…` is caught, without turning literal `+` into spaces
 * (which would corrupt base64-ish tokens).
 */
export function redactErrorAgentPromptText(text: string) {
	const original = redactPlainErrorAgentPromptText(text)
	let decoded = text
	try {
		decoded = decodeURIComponent(text)
	} catch {
		return original
	}
	if (decoded === text) return original
	// Always prefer the decoded redaction when percent-decoding changed the
	// string. Token matchers stop at `%`, so an encoded JWT/Bearer can look
	// "already redacted" in the raw copy while the remainder of the secret
	// stays visible — comparing REDACTED hit counts hid that leak.
	return redactPlainErrorAgentPromptText(decoded)
}

function pushIdLine(
	lines: Array<string>,
	label: string,
	value: string | null | undefined,
) {
	const trimmed = value?.trim()
	if (!trimmed) return
	lines.push(`${label}: ${redactErrorAgentPromptText(trimmed)}`)
}

/**
 * Build a ready-to-paste prompt for Claude / ChatGPT / Grok / Cursor.
 * All free-form fields are redacted before assembly.
 */
export function buildErrorAgentPrompt(input: ErrorAgentPromptInput): string {
	const lines: Array<string> = [
		'I hit an error on the Kody website that you cannot see from MCP/CLI.',
		`What I was doing: ${redactErrorAgentPromptText(input.activity.trim())}`,
	]

	const code = input.errorCode?.trim()
	if (code) {
		lines.push(`Error code: ${redactErrorAgentPromptText(code)}`)
	}
	lines.push(
		`Exact error: ${redactErrorAgentPromptText(input.errorMessage.trim())}`,
	)

	const ids = input.ids
	if (ids) {
		pushIdLine(lines, 'Package name', ids.packageName)
		pushIdLine(lines, 'Package kody_id', ids.packageKodyId)
		pushIdLine(lines, 'Repo', ids.repo)
		pushIdLine(lines, 'Credential name', ids.credentialName)
		pushIdLine(lines, 'Credential id', ids.credentialId)
		pushIdLine(lines, 'Org slug', ids.orgSlug)
		pushIdLine(lines, 'Org id', ids.orgId)
		pushIdLine(lines, 'Request id', ids.requestId)
		pushIdLine(lines, 'Run id', ids.runId)
		pushIdLine(lines, 'Connection name', ids.connectionName)
		pushIdLine(lines, 'Provider', ids.provider)
		pushIdLine(lines, 'Username', ids.username)
		pushIdLine(lines, 'Path', ids.path)
	}

	const cause = input.likelyCause?.trim()
	if (cause) {
		lines.push(`Likely cause: ${redactErrorAgentPromptText(cause)}`)
	}

	const nextSteps = (input.nextSteps ?? [])
		.map((step) => step.trim())
		.filter(Boolean)
	if (nextSteps.length > 0) {
		lines.push('Concrete next steps:')
		for (const step of nextSteps) {
			lines.push(`- ${redactErrorAgentPromptText(step)}`)
		}
	}

	const tools = (input.kodyTools ?? [])
		.map((tool) => tool.trim())
		.filter(Boolean)
	if (tools.length > 0) {
		lines.push('Kody tools to use:')
		for (const tool of tools) {
			lines.push(`- ${redactErrorAgentPromptText(tool)}`)
		}
	}

	const docs = (input.docs ?? []).map((doc) => doc.trim()).filter(Boolean)
	if (docs.length > 0) {
		lines.push('Relevant docs:')
		for (const doc of docs) {
			lines.push(`- ${redactErrorAgentPromptText(doc)}`)
		}
	}

	lines.push(
		'Fix the underlying issue, then tell me what to try again on the website. Never ask me to paste secrets, tokens, or other users’ data into chat.',
	)

	return lines.join('\n')
}

/** Escape text for HTML text nodes (not attributes). */
export function escapeErrorAgentPromptHtml(text: string) {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

/** Classic script (served from `public/`) that wires the static block's button. */
export const ERROR_AGENT_PROMPT_COPY_SCRIPT_SRC = '/error-agent-prompt-copy.js'

const copyIconSvg = `<svg data-icon="copy" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true" focusable="false"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6.5 15.25V15.25C5.5335 15.25 4.75 14.4665 4.75 13.5V6.75C4.75 5.64543 5.64543 4.75 6.75 4.75H13.5C14.4665 4.75 15.25 5.5335 15.25 6.5V6.5"/><rect width="10.5" height="10.5" x="8.75" y="8.75" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" rx="2"/></svg>`
const checkIconSvg = `<svg data-icon="check" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true" focusable="false"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.75 12.8665L8.33995 16.4138C9.15171 17.5256 10.8179 17.504 11.6006 16.3715L18.25 6.75"/></svg>`

// Mirrors the small ghost pill + swap-label CopyTextButton look with plain
// CSS: these documents load no app bundle. Custom properties fall back to
// currentColor where the page has no Kody stylesheet.
const copyButtonStyles = `<style>
[data-error-agent-prompt-head]{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.5rem 1rem;margin:0.75rem 0 0.5rem}
[data-error-agent-prompt-copy]{display:inline-grid;align-items:center;justify-items:center;box-sizing:border-box;min-height:2.25rem;padding:0.5rem 0.875rem;border:none;border-radius:0.625rem;background:transparent;color:var(--color-text,inherit);box-shadow:inset 0 0 0 1.5px var(--color-border,currentColor);font:650 0.875rem/1.25rem var(--font-display,inherit);cursor:pointer;white-space:nowrap;transition:background-color 160ms ease-out,box-shadow 160ms ease-out}
[data-error-agent-prompt-copy][hidden]{display:none}
[data-error-agent-prompt-copy]>span{grid-area:1/1;display:inline-flex;align-items:center;gap:0.375rem;transition:opacity 120ms ease-out}
[data-error-agent-prompt-copy]>span:not([data-active]){opacity:0;visibility:hidden}
@media (hover:hover) and (pointer:fine){[data-error-agent-prompt-copy]:hover{background-color:var(--color-surface,transparent);box-shadow:inset 0 0 0 1.5px var(--color-text-muted,currentColor)}}
@media (any-pointer:coarse){[data-error-agent-prompt-copy]{min-height:2.75rem}}
[data-error-agent-prompt-status]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
</style>`

/**
 * Static HTML block for pages without a hydrated Copy button (static 500,
 * package-app HTML). Uses a details/pre so the prompt is copyable without JS;
 * the Copy prompt button stays hidden until
 * {@link ERROR_AGENT_PROMPT_COPY_SCRIPT_SRC} runs and copies the `<pre>` text.
 */
export function renderErrorAgentPromptStaticHtml(prompt: string) {
	const safe = escapeErrorAgentPromptHtml(prompt)
	return `<details ${ERROR_AGENT_PROMPT_ATTR}="" data-testid="${ERROR_AGENT_PROMPT_TEST_ID}" style="margin-top:1.25rem;text-align:left">
<summary style="cursor:pointer;font-weight:650">${ERROR_AGENT_PROMPT_IDLE_LABEL}</summary>
${copyButtonStyles}
<div data-error-agent-prompt-head="">
<p style="margin:0;color:inherit;opacity:0.85">Paste this into Claude, ChatGPT, Grok, or Cursor so your agent can fix it.</p>
<button type="button" data-error-agent-prompt-copy="" hidden><span data-label="idle" data-active="">${copyIconSvg}Copy prompt</span><span data-label="copied">${checkIconSvg}Copied</span><span data-label="error">Copy failed</span></button>
<span data-error-agent-prompt-status="" role="status" aria-live="polite"></span>
</div>
<pre data-error-agent-prompt-text="" style="margin:0;padding:0.75rem;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid currentColor;border-radius:0.5rem;font-size:0.85rem">${safe}</pre>
</details>`
}
