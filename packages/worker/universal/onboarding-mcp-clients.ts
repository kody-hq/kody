/**
 * Per-client MCP setup snippets and copy for the onboarding page.
 * Keep this module free of Remix/UI so config builders stay unit-testable
 * and origin can highlight the same snippets the tabs render.
 */

import { breakpoints } from '#universal/styles/tokens.ts'

export type McpClientKind =
	| 'cursor'
	| 'cursor-local'
	| 'cursor-cloud'
	| 'chatgpt'
	| 'codex'
	| 'claude-desktop'
	| 'grok'
	| 'grok-cli'
	| 'grok-bot'
	| 'claude-code'
	| 'opencode'
	| 'copilot'
	| 'copilot-app'
	| 'devin'
	| 'gemini'
	| 'openclaw'
	| 'hermes'
	| 'muse'
	| 'wajo'
	| 'cue'
	| 'openmuse'
	| 'dots'
	| 'other'

export type OnboardingAgentSurface = 'desktop' | 'mobile'

export type McpClientTab = {
	id: McpClientKind
	label: string
	/** True for hosts that are primarily chat/non-coding agents. */
	isNonCodingAgent: boolean
}

export const mcpClientTabs = [
	{ id: 'cursor', label: 'Cursor', isNonCodingAgent: false },
	{ id: 'cursor-local', label: 'Cursor Local', isNonCodingAgent: false },
	{ id: 'cursor-cloud', label: 'Cursor Cloud', isNonCodingAgent: false },
	{ id: 'chatgpt', label: 'ChatGPT.com', isNonCodingAgent: true },
	{ id: 'codex', label: 'Codex', isNonCodingAgent: false },
	{ id: 'claude-desktop', label: 'Claude Desktop', isNonCodingAgent: true },
	{ id: 'grok', label: 'Grok.com', isNonCodingAgent: true },
	{ id: 'grok-cli', label: 'Grok CLI', isNonCodingAgent: false },
	{ id: 'grok-bot', label: 'Grok Bot', isNonCodingAgent: true },
	{ id: 'claude-code', label: 'Claude Code', isNonCodingAgent: false },
	{ id: 'opencode', label: 'OpenCode', isNonCodingAgent: false },
	{ id: 'copilot', label: 'Copilot', isNonCodingAgent: false },
	{ id: 'copilot-app', label: 'Copilot App', isNonCodingAgent: true },
	{ id: 'devin', label: 'Devin', isNonCodingAgent: false },
	{ id: 'gemini', label: 'Gemini', isNonCodingAgent: true },
	{ id: 'openclaw', label: 'OpenClaw', isNonCodingAgent: false },
	{ id: 'hermes', label: 'Hermes Agent', isNonCodingAgent: false },
	{ id: 'muse', label: 'Muse', isNonCodingAgent: false },
	{ id: 'wajo', label: 'Wajo', isNonCodingAgent: false },
	{ id: 'cue', label: 'Cue', isNonCodingAgent: false },
	{ id: 'openmuse', label: 'OpenMuse', isNonCodingAgent: false },
	{ id: 'dots', label: 'Dots', isNonCodingAgent: false },
	{ id: 'other', label: 'Other', isNonCodingAgent: false },
] as const satisfies ReadonlyArray<McpClientTab>

/**
 * Desktop chooser: coding agents first, then the highest-traffic chat hosts
 * that are not already represented. Devin stands in for Devin Desktop
 * (ex-Windsurf). OpenCode is the Cline / OpenCode slot. OpenClaw and Hermes
 * Agent are the local-first personal-agent slots. ChatGPT.com, Claude Desktop,
 * and Grok Bot fill the leftover seats so the auto-fill desktop grid lands on
 * complete rows with Not listed (12 cards). Gemini stays under More on desktop
 * (still featured on mobile). Muse Code, Wajo, Cue, OpenMuse, and Dots are
 * lower-priority MCP peers: they stay off the featured 12 and appear under Not
 * listed (and Account → Connections). Grok.com, Grok CLI, and the Copilot app
 * stay under Not listed (Copilot desktop/CLI is already featured; Aider is not
 * a Kody connect path yet).
 */
export const onboardingDesktopFeaturedAgentIds = [
	'claude-code',
	'cursor',
	'codex',
	'copilot',
	'devin',
	'opencode',
	'openclaw',
	'hermes',
	'chatgpt',
	'claude-desktop',
	'grok-bot',
] as const satisfies ReadonlyArray<McpClientKind>

/**
 * Lower-priority action agents / MCP peers. Shown under Not listed on
 * Get started (and on Account → Connections via the full catalog), not in
 * the featured Step 1 grid. Order: Muse, Wajo, Cue, OpenMuse, Dots.
 */
const onboardingSecondaryAgentIds = [
	'muse',
	'wajo',
	'cue',
	'openmuse',
	'dots',
] as const satisfies ReadonlyArray<McpClientKind>

/**
 * Phone chooser: only hosts with a real mobile app. Desktop-only CLIs and
 * IDEs (Claude Code, Devin, Codex, Copilot CLI, OpenCode, OpenClaw, Hermes
 * Agent, Muse, Cursor) stay off this list and appear under Not listed on a phone.
 */
export const onboardingMobileFeaturedAgentIds = [
	'chatgpt',
	'claude-desktop',
	'copilot-app',
	'gemini',
	'grok',
	'grok-bot',
] as const satisfies ReadonlyArray<McpClientKind>

/** Narrow viewport or a coarse phone-like pointer. */
const onboardingMobileAgentMediaQuery = `(max-width: ${breakpoints.mobile}), (hover: none) and (pointer: coarse)`

export const onboardingMobileAgentMq = `@media ${onboardingMobileAgentMediaQuery}`

function onboardingFeaturedAgentIdsFor(
	surface: OnboardingAgentSurface,
): ReadonlyArray<McpClientKind> {
	return surface === 'mobile'
		? onboardingMobileFeaturedAgentIds
		: onboardingDesktopFeaturedAgentIds
}

export function onboardingMoreAgentIdsFor(
	surface: OnboardingAgentSurface,
): Array<McpClientKind> {
	const featured = new Set<McpClientKind>(
		onboardingFeaturedAgentIdsFor(surface),
	)
	return mcpClientTabs
		.map((tab) => tab.id)
		.filter((id) => id !== 'other' && !featured.has(id))
}

export type OnboardingRandomInt = (maxExclusive: number) => number

export type OnboardingAgentChooserPick = {
	desktopFeatured: Array<McpClientKind>
	mobileFeatured: Array<McpClientKind>
	desktopMore: Array<McpClientKind>
	mobileMore: Array<McpClientKind>
}

export function randomOnboardingInt(maxExclusive: number): number {
	if (maxExclusive <= 0) {
		throw new Error('randomOnboardingInt requires a positive maximum')
	}
	const bytes = new Uint32Array(1)
	crypto.getRandomValues(bytes)
	return bytes[0]! % maxExclusive
}

export function shuffleOnboardingAgentIds<T>(
	ids: ReadonlyArray<T>,
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): Array<T> {
	const next = [...ids]
	for (let index = next.length - 1; index > 0; index--) {
		const span = index + 1
		const raw = randomInt(span)
		const swapAt = ((raw % span) + span) % span
		const current = next[index]
		const other = next[swapAt]
		if (!current || !other) continue
		next[index] = other
		next[swapAt] = current
	}
	return next
}

/** One SSR pick so hydrate matches. Polls must not reshuffle. */
export function pickOnboardingAgentChooser(
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): OnboardingAgentChooserPick {
	return {
		desktopFeatured: shuffleOnboardingAgentIds(
			onboardingDesktopFeaturedAgentIds,
			randomInt,
		),
		mobileFeatured: shuffleOnboardingAgentIds(
			onboardingMobileFeaturedAgentIds,
			randomInt,
		),
		desktopMore: shuffleOnboardingAgentIds(
			onboardingMoreAgentIdsFor('desktop'),
			randomInt,
		),
		mobileMore: shuffleOnboardingAgentIds(
			onboardingMoreAgentIdsFor('mobile'),
			randomInt,
		),
	}
}

export function canonicalOnboardingAgentChooser(): OnboardingAgentChooserPick {
	return {
		desktopFeatured: [...onboardingDesktopFeaturedAgentIds],
		mobileFeatured: [...onboardingMobileFeaturedAgentIds],
		desktopMore: onboardingMoreAgentIdsFor('desktop'),
		mobileMore: onboardingMoreAgentIdsFor('mobile'),
	}
}

function isPermutation(
	actual: ReadonlyArray<McpClientKind>,
	expected: ReadonlyArray<McpClientKind>,
) {
	if (actual.length !== expected.length) return false
	const expectedIds = new Set(expected)
	if (new Set(actual).size !== expectedIds.size) return false
	return actual.every((id) => expectedIds.has(id))
}

export function isValidOnboardingAgentChooserPick(
	value: OnboardingAgentChooserPick,
): boolean {
	return (
		isPermutation(value.desktopFeatured, onboardingDesktopFeaturedAgentIds) &&
		isPermutation(value.mobileFeatured, onboardingMobileFeaturedAgentIds) &&
		isPermutation(value.desktopMore, onboardingMoreAgentIdsFor('desktop')) &&
		isPermutation(value.mobileMore, onboardingMoreAgentIdsFor('mobile'))
	)
}

export type OnboardingAgentViewport = 'desktop-only' | 'mobile-only' | 'both'

export function onboardingAgentViewport(
	id: McpClientKind,
): OnboardingAgentViewport | 'none' {
	if (id === 'other') return 'both'
	const desktop = (
		onboardingDesktopFeaturedAgentIds as ReadonlyArray<McpClientKind>
	).includes(id)
	const mobile = (
		onboardingMobileFeaturedAgentIds as ReadonlyArray<McpClientKind>
	).includes(id)
	if (desktop && mobile) return 'both'
	if (desktop) return 'desktop-only'
	if (mobile) return 'mobile-only'
	return 'none'
}

export function onboardingPickerAgentIds(
	chooser: OnboardingAgentChooserPick,
): Array<McpClientKind> {
	const seen = new Set<McpClientKind>(chooser.desktopFeatured)
	const mobileOnly = chooser.mobileFeatured.filter((id) => !seen.has(id))
	return [...chooser.desktopFeatured, ...mobileOnly]
}

export function onboardingNotListedAgentIds(
	chooser: OnboardingAgentChooserPick,
): Array<{ id: McpClientKind; viewport: OnboardingAgentViewport }> {
	const desktopSet = new Set<McpClientKind>(chooser.desktopFeatured)
	const mobileSet = new Set<McpClientKind>(chooser.mobileFeatured)
	const desktopOnly = chooser.desktopFeatured
		.filter((id) => !mobileSet.has(id))
		.map((id) => ({ id, viewport: 'mobile-only' as const }))
	const mobileOnly = chooser.mobileFeatured
		.filter((id) => !desktopSet.has(id))
		.map((id) => ({ id, viewport: 'desktop-only' as const }))
	const secondary = onboardingSecondaryAgentIds
		.filter((id) => !desktopSet.has(id) && !mobileSet.has(id))
		.map((id) => ({ id, viewport: 'both' as const }))
	return [...desktopOnly, ...mobileOnly, ...secondary]
}

export function onboardingViewportCss(
	viewport: OnboardingAgentViewport,
	shownDisplay: string,
) {
	if (viewport === 'both') return { display: shownDisplay }
	if (viewport === 'desktop-only') {
		return {
			display: shownDisplay,
			[onboardingMobileAgentMq]: { display: 'none' },
		}
	}
	return {
		display: 'none',
		[onboardingMobileAgentMq]: { display: shownDisplay },
	}
}

export function onboardingAgentLabel(
	id: McpClientKind,
	surface: OnboardingAgentSurface = 'desktop',
): string {
	if (id === 'other') return 'Not listed'
	if (surface === 'mobile') {
		switch (id) {
			case 'chatgpt':
				return 'ChatGPT'
			case 'claude-desktop':
				return 'Claude'
			case 'copilot-app':
				return 'Copilot'
			case 'grok':
				return 'Grok'
			default:
				break
		}
	}
	return mcpClientById(id).label
}

export function onboardingAgentIconName(
	id: McpClientKind,
	_surface: OnboardingAgentSurface = 'desktop',
): string | null {
	switch (id) {
		case 'cursor':
		case 'cursor-local':
		case 'cursor-cloud':
			return 'cursor'
		case 'claude-code':
			return 'claudecode'
		case 'claude-desktop':
			return 'claude'
		case 'chatgpt':
			return 'chatgpt'
		case 'codex':
			return 'codex'
		case 'grok':
		case 'grok-cli':
			return 'grok'
		case 'grok-bot':
			return 'grokbot'
		case 'copilot':
		case 'copilot-app':
			return 'githubcopilot'
		case 'opencode':
			return 'opencode'
		case 'devin':
			return 'devin'
		case 'gemini':
			return 'gemini'
		case 'openclaw':
			return 'openclaw'
		case 'hermes':
			return 'hermes'
		case 'muse':
			return 'muse'
		case 'wajo':
			return 'wajo'
		case 'cue':
			return 'cue'
		case 'openmuse':
			return 'openmuse'
		case 'dots':
			return 'dots'
		case 'other':
			return null
		default: {
			const exhaustive: never = id
			return exhaustive
		}
	}
}

export function isMcpClientKind(
	value: string | null | undefined,
): value is McpClientKind {
	return mcpClientTabs.some((tab) => tab.id === value)
}

export function mcpClientById(id: McpClientKind): McpClientTab {
	const tab = mcpClientTabs.find((candidate) => candidate.id === id)
	if (!tab) {
		throw new Error(`Unknown MCP client ${id}`)
	}
	return tab
}

/** Collapse every wizard URL onto one payload key so picker navigations reuse data. */
export function onboardingDataHref(href: string): string {
	const url = new URL(href, 'https://kody.local')
	if (
		url.pathname === '/onboarding' ||
		url.pathname.startsWith('/onboarding/step-')
	) {
		url.pathname = '/onboarding'
	}
	url.hash = ''
	return `${url.pathname}${url.search}`
}

/** GitHub docs for adding MCP servers in Copilot CLI (also used by the app). */
const copilotCliMcpGuideUrl =
	'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers'

/** GitHub docs for MCP in the GitHub Copilot app. */
const copilotAppCustomizeGuideUrl =
	'https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app'

export const chatGptDeveloperModeGuideUrl =
	'https://developers.openai.com/api/docs/guides/developer-mode'

const cursorMcpGuideUrl = 'https://cursor.com/docs/mcp'

/** Claude Desktop / Claude.ai custom remote connector help. */
const claudeCustomConnectorsGuideUrl =
	'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp'

/** Long-form host notes when a vendor page is not a better first click. */
const kodyConnectYourAgentUrl =
	'https://raw.githubusercontent.com/kody-hq/kody/main/docs/use/connect-your-agent.md'

/** Grok.com UI for adding a custom remote MCP connector. */
export const grokConnectorsUrl = 'https://grok.com/connectors'

const grokCustomMcpGuideUrl = 'https://docs.x.ai/grok/connectors'

/** Grok CLI (`grok`) MCP add / config.toml docs. */
const grokCliMcpGuideUrl = 'https://docs.x.ai/build/features/mcp-servers'

/** OpenClaw Control UI + CLI docs for adding a remote MCP server. */
const openClawMcpGuideUrl = 'https://docs.openclaw.ai/tools/mcp'

/** Hermes Agent MCP docs (`mcp_servers` in config.yaml, `auth: oauth`). */
export const hermesMcpGuideUrl =
	'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp'

/**
 * Muse Code MCP + OAuth docs (`mcp_servers` in settings, `muse mcp login`).
 * Extending page covers remote streamable_http servers and OAuth sign-in.
 */
export const museMcpGuideUrl = 'https://dev.meta.ai/docs/muse-code/extending/'

/** Wajo (Fo action agent) product site — MCP connect is via Wajo sign-in. */
export const wajoSiteUrl = 'https://wajo.ai'

/** Cue (personal AI agents by Manus) product site. */
export const cueSiteUrl = 'https://cue.im'

/**
 * OpenMuse and Kody guide (same-origin docs path — not openmuse.ai).
 * Distinct from Muse Code (`muse`).
 */
export const openMuseGuideUrl = '/docs/openmuse'

/** OpenAI Dots product intro (personal agent / MCP peer). */
export const dotsIntroUrl = 'https://openai.com/index/introducing-dots/'

/** Cursor Marketplace listing for the official Kody plugin (production). */
export const kodyCursorMarketplaceUrl = 'https://cursor.com/marketplace/kody'

/** ChatGPT plugin directory listing for Kody (production MCP). */
export const kodyChatGptPluginUrl =
	'https://chatgpt.com/plugins/plugin_asdk_app_6a95fefc5c1081919756fdd35dd918ee'

/** Cursor chat command shown on the marketplace listing. */
export const kodyCursorAddPluginCommand = '/add-plugin kody'

/** Confirmed Cursor Marketplace plugin id for Kody. */
const kodyMarketplacePluginId = '56286216'

/** Confirmed Grok Bot one-click add for the official Kody plugin. */
export const grokBotInstallUrl = `grokbot://app/v1/plugin/add?id=${kodyMarketplacePluginId}`

const grokBotConnectPluginsUrl =
	'https://cursor.com/help/grok-bot/connect-plugins'

function onboardingAgentHelpHref(id: McpClientKind) {
	switch (id) {
		case 'cursor':
		case 'cursor-local':
		case 'cursor-cloud':
			return cursorMcpGuideUrl
		case 'chatgpt':
		case 'codex':
		case 'claude-code':
		case 'opencode':
		case 'devin':
		case 'gemini':
		case 'other':
			return kodyConnectYourAgentUrl
		case 'claude-desktop':
			return claudeCustomConnectorsGuideUrl
		case 'grok':
			return grokCustomMcpGuideUrl
		case 'grok-cli':
			return grokCliMcpGuideUrl
		case 'grok-bot':
			return grokBotConnectPluginsUrl
		case 'copilot':
			return copilotCliMcpGuideUrl
		case 'copilot-app':
			return copilotAppCustomizeGuideUrl
		case 'openclaw':
			return openClawMcpGuideUrl
		case 'hermes':
			return hermesMcpGuideUrl
		case 'muse':
			return museMcpGuideUrl
		case 'wajo':
			return wajoSiteUrl
		case 'cue':
			return cueSiteUrl
		case 'openmuse':
			return openMuseGuideUrl
		case 'dots':
			return dotsIntroUrl
		default: {
			const exhaustive: never = id
			return exhaustive
		}
	}
}

/** Same shape on every card: the agent name, then connection docs. */
export function onboardingAgentHelp(
	id: McpClientKind,
	surface: OnboardingAgentSurface = 'desktop',
): {
	href: string
	label: string
} {
	return {
		href: onboardingAgentHelpHref(id),
		label: `${onboardingAgentLabel(id, surface)} connection docs`,
	}
}

/**
 * Dedicated ChatGPT / Codex connector icon. ChatGPT wants 256×256 and
 * rejects uploads over 10 KB; `/apple-touch-icon.png` is larger, so
 * onboarding points here.
 */
const kodyAppIconPath = '/images/kody-app-icon.png'
export const kodyAppIconFilename = kodyAppIconPath.slice(
	kodyAppIconPath.lastIndexOf('/') + 1,
)

/** Square PNG suitable for ChatGPT plugin / connector app icons. */
export function buildKodyAppIconUrl(mcpServerUrl: string) {
	return new URL(kodyAppIconPath, mcpServerUrl).href
}

/** Claude Desktop often does not bind MCP tools until the next turn. */
export const claudeDesktopToolHint =
	'After connecting, start a new chat and ask Claude to list Kody tools before the first task. Claude Desktop often does not bind MCP tools until that next turn.'

/** Production MCP URL. `@kodycodes/cli install` uses this when `--mcp-url` is omitted. */
export const defaultKodyMcpUrl = 'https://kody.codes/mcp'

/**
 * Copyable Automatic command for every client. Production uses the CLI
 * default; preview and local origins pass `--mcp-url` so install writes
 * this deployment's MCP endpoint.
 */
export function isDefaultKodyMcpUrl(mcpServerUrl: string) {
	return normalizeMcpUrl(mcpServerUrl) === defaultKodyMcpUrl
}

export function buildKodyCliInstallCommand(mcpServerUrl: string) {
	if (isDefaultKodyMcpUrl(mcpServerUrl)) {
		return 'npx @kodycodes/cli install'
	}
	return `npx @kodycodes/cli install --mcp-url ${mcpServerUrl}`
}

function normalizeMcpUrl(mcpServerUrl: string) {
	return mcpServerUrl.replace(/\/+$/u, '')
}

function prettyJson(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
}

/** VS Code protocol handler for installing a remote MCP server. */
export function buildVsCodeInstallUrl(mcpServerUrl: string) {
	const config = encodeURIComponent(
		JSON.stringify({
			name: 'kody',
			type: 'http',
			url: mcpServerUrl,
		}),
	)
	return `vscode:mcp/install?${config}`
}

/** Claude Code project `.mcp.json` or user-scoped `mcpServers` entry. */
export function buildClaudeCodeMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcpServers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
}

export function buildClaudeCodeAddCommand(mcpServerUrl: string) {
	return `claude mcp add --transport http -s user kody ${mcpServerUrl}`
}

/**
 * Codex desktop registers `codex://` and launches on those URLs (OAuth
 * callbacks use the same scheme). Prefill is not a documented public
 * contract, so this opens the app with the MCP URL in the query and the
 * CLI remains the install fallback.
 */
export function buildCodexMcpDeepLink(mcpServerUrl: string) {
	const params = new URLSearchParams({
		name: 'kody',
		url: mcpServerUrl,
	})
	return `codex://mcp/add?${params}`
}

/** Codex CLI streamable HTTP add. OAuth may need `codex mcp login kody`. */
export function buildCodexMcpAddCommand(mcpServerUrl: string) {
	return `codex mcp add kody --url ${mcpServerUrl}`
}

export const codexMcpLoginCommand = 'codex mcp login kody'

/**
 * OpenCode non-interactive remote add (`opencode mcp add <name> --url`).
 * OAuth may need `opencode mcp auth kody`.
 */
export function buildOpenCodeMcpAddCommand(mcpServerUrl: string) {
	return `opencode mcp add kody --url ${mcpServerUrl}`
}

export const openCodeMcpAuthCommand = 'opencode mcp auth kody'

/**
 * OpenClaw remote Streamable HTTP add. OAuth needs
 * `openclaw mcp login kody` after the definition is saved.
 */
export function buildOpenClawMcpAddCommand(mcpServerUrl: string) {
	return `openclaw mcp add kody --url ${mcpServerUrl} --transport streamable-http --auth oauth`
}

export const openClawMcpLoginCommand = 'openclaw mcp login kody'

const openClawMcpDoctorCommand = 'openclaw mcp doctor kody --probe'

/**
 * Hermes Agent remote add. `--auth oauth` runs the browser sign-in during
 * the connection probe; without it Hermes asks for a bearer header instead.
 */
export function buildHermesMcpAddCommand(mcpServerUrl: string) {
	return `hermes mcp add kody --url ${mcpServerUrl} --auth oauth`
}

/** Re-runs Hermes OAuth for a saved server (new machine, expired grant). */
export const hermesMcpLoginCommand = 'hermes mcp login kody'

/** Where Hermes caches MCP OAuth tokens (per profile, 0600). */
export const hermesMcpTokensPath = '~/.hermes/mcp-tokens/kody.json'

/** VS Code Copilot `.vscode/mcp.json` (root key is `servers`, not `mcpServers`). */
export function buildVsCodeMcpJson(mcpServerUrl: string) {
	return prettyJson({
		servers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
}

/** Copilot CLI one-shot remote HTTP add (writes `~/.copilot/mcp-config.json`). */
export function buildCopilotCliAddCommand(mcpServerUrl: string) {
	return `copilot mcp add --transport http kody ${mcpServerUrl}`
}

/**
 * Copilot CLI / Copilot app user config (`~/.copilot/mcp-config.json`).
 * Root key is `mcpServers` — Copilot CLI does not read `.vscode/mcp.json`.
 */
export function buildCopilotCliMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcpServers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
}

/** OpenCode `opencode.json` remote server entry. */
export function buildOpenCodeMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcp: {
			kody: {
				type: 'remote',
				url: mcpServerUrl,
				enabled: true,
			},
		},
	})
}

/** OpenClaw `~/.openclaw/openclaw.json` `mcp.servers` entry. */
export function buildOpenClawMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcp: {
			servers: {
				kody: {
					url: mcpServerUrl,
					transport: 'streamable-http',
					auth: 'oauth',
					enabled: true,
				},
			},
		},
	})
}

/** Hermes Agent `~/.hermes/config.yaml` `mcp_servers` entry. */
export function buildHermesMcpYaml(mcpServerUrl: string) {
	return [
		'mcp_servers:',
		'  kody:',
		`    url: ${JSON.stringify(mcpServerUrl)}`,
		'    auth: oauth',
		'',
	].join('\n')
}

/**
 * Muse Code user settings (`~/.config/muse/settings.json`). Merge the
 * `mcp_servers.kody` entry into an existing file; new files need
 * `schema_version: 1`.
 */
export function buildMuseSettingsJson(mcpServerUrl: string) {
	return prettyJson({
		schema_version: 1,
		mcp_servers: {
			kody: {
				transport: 'streamable_http',
				url: mcpServerUrl,
				mode: 'optional',
			},
		},
	})
}

/** Muse OAuth for a remote server declared in `mcp_servers`. */
export const museMcpLoginCommand = 'muse mcp login kody'

/** Codex shared `~/.codex/config.toml` streamable HTTP entry. */
export function buildCodexMcpToml(mcpServerUrl: string) {
	return [
		'[mcp_servers.kody]',
		`url = ${JSON.stringify(mcpServerUrl)}`,
		'',
	].join('\n')
}

/** Grok CLI one-shot remote HTTP add (writes `~/.grok/config.toml`). */
export function buildGrokCliAddCommand(mcpServerUrl: string) {
	return `grok mcp add --transport http --scope user kody ${mcpServerUrl}`
}

/** Grok CLI user config (`~/.grok/config.toml`) streamable HTTP entry. */
export function buildGrokCliMcpToml(mcpServerUrl: string) {
	return [
		'[mcp_servers.kody]',
		`url = ${JSON.stringify(mcpServerUrl)}`,
		'',
	].join('\n')
}

/**
 * Every copyable snippet the onboarding MCP tabs render. Origin highlights
 * this list once per `mcpServerUrl` and the UI looks tokens up by key.
 */
export function collectOnboardingMcpSnippets(mcpServerUrl: string) {
	return [
		{ code: mcpServerUrl },
		{ code: buildKodyAppIconUrl(mcpServerUrl) },
		{ code: kodyCursorAddPluginCommand },
		{ code: grokBotInstallUrl },
		{ code: buildCodexMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildCodexMcpToml(mcpServerUrl), lang: 'toml' },
		{ code: buildGrokCliAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildGrokCliMcpToml(mcpServerUrl), lang: 'toml' },
		{ code: buildClaudeCodeAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildClaudeCodeMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildOpenCodeMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildOpenCodeMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildOpenClawMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildOpenClawMcpJson(mcpServerUrl), lang: 'json' },
		{ code: openClawMcpLoginCommand, lang: 'sh' },
		{ code: openClawMcpDoctorCommand, lang: 'sh' },
		{ code: buildHermesMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildHermesMcpYaml(mcpServerUrl), lang: 'yaml' },
		{ code: hermesMcpLoginCommand, lang: 'sh' },
		{ code: buildCopilotCliAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildVsCodeMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildCopilotCliMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildMuseSettingsJson(mcpServerUrl), lang: 'json' },
		{ code: museMcpLoginCommand, lang: 'sh' },
	]
}
