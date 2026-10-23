import {
	buildClaudeCodeAddCommand,
	buildCopilotCliAddCommand,
	buildHermesMcpAddCommand,
	buildMuseSettingsJson,
	buildOpenClawMcpAddCommand,
	buildOpenCodeMcpAddCommand,
	defaultKodyMcpUrl,
	grokBotInstallUrl,
	grokConnectorsUrl,
	kodyBotTemplateLabel,
	kodyBotTemplateSummary,
	kodyBotTemplateUrl,
	kodyChatGptPluginUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
	museMcpLoginCommand,
	openClawMcpLoginCommand,
	openCodeMcpAuthCommand,
	randomOnboardingInt,
	shuffleOnboardingAgentIds,
	type OnboardingRandomInt,
} from '#universal/onboarding-mcp-clients.ts'

/**
 * Agents with a `/with/:agent` page and a spot in the homepage agent
 * marquee: the walkthrough catalog in `walkthrough-hosts.ts`. Official
 * agents get the shortest production path from
 * `docs/use/connect-your-agent.md`; the rest get the setup prompt and the
 * MCP URL and connect themselves. Get started and the connect docs keep
 * every alternative.
 */

export type WithAgentStep = {
	text: string
	code?: string
	link?: { label: string; href: string }
	/** Renders the copy-setup-prompt button. */
	prompt?: true
}

export type WithAgent = {
	slug: string
	name: string
	/** Monochrome SVG in `public/images/icons/`. */
	icon: string
	/** False when the agent has no Kody connect path of its own yet. */
	official: boolean
	/** Replaces the default note shown above unofficial agents' steps. */
	note?: string
	pitch: string
	/**
	 * Recommended setup shown as the primary button above `steps`. When set,
	 * `steps` become the manual alternative under `alternativeTitle`.
	 */
	primaryAction?: {
		label: string
		href: string
		description: string
		alternativeTitle: string
	}
	steps: ReadonlyArray<WithAgentStep>
}

const mcpUrl = defaultKodyMcpUrl

function genericAgent<const Slug extends string>(
	agent: Pick<WithAgent, 'name' | 'icon' | 'pitch'> & { slug: Slug },
) {
	return {
		...agent,
		official: false,
		steps: [
			{
				text: `Copy this setup prompt and paste it into ${agent.name}. It points ${agent.name} at Kody\u2019s connection docs so it can connect itself.`,
				prompt: true,
			},
			{
				text: `If ${agent.name} asks for an MCP server, give it this URL (Streamable HTTP with OAuth sign-in):`,
				code: mcpUrl,
			},
			{
				text: `Sign in to Kody and approve access when asked, then ask ${agent.name} to list its Kody tools.`,
			},
		],
	} satisfies WithAgent
}

const chatGptPluginStep = {
	text: 'Add the Kody plugin from the ChatGPT plugin directory.',
	link: { label: 'Open the Kody plugin', href: kodyChatGptPluginUrl },
} satisfies WithAgentStep

export const withAgents = [
	{
		slug: 'cursor',
		name: 'Cursor',
		icon: 'cursor',
		official: true,
		pitch:
			'Keep building in Cursor. Kody gives it your team\u2019s credentials, packages, and workflows, and anything it saves runs from every other agent your team uses.',
		steps: [
			{
				text: 'Install the Kody plugin from the Cursor Marketplace.',
				link: { label: 'Open the Kody plugin', href: kodyCursorMarketplaceUrl },
			},
			{ text: 'Or run this in Cursor chat:', code: kodyCursorAddPluginCommand },
			{
				text: 'Choose Authenticate next to Kody in Cursor\u2019s MCP list, then approve access.',
			},
		],
	},
	{
		slug: 'claude-code',
		name: 'Claude Code',
		icon: 'claudecode',
		official: true,
		pitch:
			'Claude Code writes the package. Kody keeps it, runs it on a trigger, and shares it with the rest of your team.',
		steps: [
			{
				text: 'Add Kody from your terminal:',
				code: buildClaudeCodeAddCommand(mcpUrl),
			},
			{ text: 'In Claude Code, run /mcp, choose Kody, then Authenticate.' },
		],
	},
	{
		slug: 'codex',
		name: 'Codex',
		icon: 'codex',
		official: true,
		pitch:
			'Let Codex build tools your whole team can run, with credentials it uses but never sees.',
		steps: [
			chatGptPluginStep,
			{ text: 'Approve access when Codex asks you to sign in to Kody.' },
		],
	},
	{
		slug: 'chatgpt',
		name: 'ChatGPT',
		icon: 'chatgpt',
		official: true,
		pitch:
			'Use your team\u2019s packages and connected accounts from a ChatGPT conversation, on the web or on your phone.',
		steps: [
			chatGptPluginStep,
			{
				text: 'Approve access when ChatGPT asks you to sign in to Kody. Plugins need a paid ChatGPT plan.',
			},
		],
	},
	{
		slug: 'claude',
		name: 'Claude',
		icon: 'claude',
		official: true,
		pitch:
			'Bring your team\u2019s tools and connected accounts into Claude conversations on desktop, web, and mobile.',
		steps: [
			{
				text: 'In Claude, open Settings, then Connectors, and add a custom connector with this URL:',
				code: mcpUrl,
			},
			{
				text: 'Approve access, then start a new chat and ask Claude to list its Kody tools.',
			},
		],
	},
	{
		slug: 'copilot',
		name: 'GitHub Copilot',
		icon: 'githubcopilot',
		official: true,
		pitch:
			'Give Copilot in VS Code or the terminal the same credentials and packages the rest of your team uses.',
		steps: [
			{
				text: 'Add Kody to Copilot CLI:',
				code: buildCopilotCliAddCommand(mcpUrl),
			},
			{
				text: 'Approve access when Copilot asks you to sign in. In VS Code, add the same URL as an HTTP MCP server and use Agent mode.',
			},
		],
	},
	{
		slug: 'devin',
		name: 'Devin',
		icon: 'devin',
		official: true,
		pitch:
			'Let Devin use your team\u2019s credentials and packages without pasting a single key into a session.',
		steps: [
			{
				text: 'In Devin, add a custom remote MCP server with this URL:',
				code: mcpUrl,
			},
			{ text: 'Approve access when Devin opens the sign-in window.' },
		],
	},
	{
		slug: 'gemini',
		name: 'Gemini',
		icon: 'gemini',
		official: true,
		pitch:
			'Run your team\u2019s packages from the Gemini app, with credentials Gemini never sees.',
		steps: [
			{
				text: 'In the Gemini app, add a custom MCP connector with this URL:',
				code: mcpUrl,
			},
			{ text: 'Approve access when Google prompts you.' },
		],
	},
	{
		slug: 'grok',
		name: 'Grok',
		icon: 'grok',
		official: true,
		pitch:
			'Bring your team\u2019s tools into Grok conversations through one custom connector.',
		steps: [
			{
				text: 'Open Grok connectors, choose New Connector, then Custom.',
				link: { label: 'Open Grok connectors', href: grokConnectorsUrl },
			},
			{ text: 'Paste this URL, then approve access:', code: mcpUrl },
		],
	},
	{
		slug: 'grok-bot',
		name: 'Grok Bot',
		icon: 'grokbot',
		official: true,
		pitch:
			'Start from the Kody Bot template and Grok Bot works on your Kody repos and packages through the Kody CLI and git.',
		primaryAction: {
			label: kodyBotTemplateLabel,
			href: kodyBotTemplateUrl,
			description: kodyBotTemplateSummary,
			alternativeTitle: 'Or add the Kody plugin to a Grok Bot you already use',
		},
		steps: [
			{
				text: 'Add the Kody plugin to Grok Bot.',
				link: { label: 'Add Kody to Grok Bot', href: grokBotInstallUrl },
			},
			{ text: 'Or open Plugins in the Grok Bot sidebar and add Kody.' },
		],
	},
	{
		slug: 'opencode',
		name: 'OpenCode',
		icon: 'opencode',
		official: true,
		pitch:
			'Point OpenCode at Kody, and every package it writes becomes something your whole team can run.',
		steps: [
			{
				text: 'Add Kody from your terminal:',
				code: buildOpenCodeMcpAddCommand(mcpUrl),
			},
			{ text: 'Then sign in:', code: openCodeMcpAuthCommand },
		],
	},
	{
		slug: 'openclaw',
		name: 'OpenClaw',
		icon: 'openclaw',
		official: true,
		pitch:
			'Give your local-first OpenClaw agent the shared credentials and workflows your team keeps in Kody.',
		steps: [
			{
				text: 'Add Kody from your terminal:',
				code: buildOpenClawMcpAddCommand(mcpUrl),
			},
			{ text: 'Then sign in:', code: openClawMcpLoginCommand },
		],
	},
	{
		slug: 'hermes',
		name: 'Hermes Agent',
		icon: 'hermes',
		official: true,
		pitch:
			'Give Hermes the shared credentials and packages your team keeps in Kody, from the terminal or any chat app it runs in.',
		steps: [
			{
				text: 'Add Kody on the machine that runs Hermes:',
				code: buildHermesMcpAddCommand(mcpUrl),
			},
			{
				text: 'Approve access in the Kody sign-in window, then choose which tools Hermes can use. Hermes saves the server to ~/.hermes/config.yaml.',
			},
			{
				text: 'Run /reload-mcp in open Hermes sessions, or start a new one, then ask Hermes to list its Kody tools.',
			},
		],
	},
	{
		slug: 'muse',
		name: 'Muse',
		icon: 'muse',
		official: true,
		pitch:
			'Connect Muse Code to Kody so the tools it builds outlive the session and reach the rest of your team.',
		steps: [
			{
				text: 'Add Kody to ~/.config/muse/settings.json:',
				code: buildMuseSettingsJson(mcpUrl).trimEnd(),
			},
			{ text: 'Then sign in:', code: museMcpLoginCommand },
		],
	},
	genericAgent({
		slug: 'amp',
		name: 'Amp',
		icon: 'amp',
		pitch:
			'Let Amp build packages your whole team can run, with credentials it uses but never sees.',
	}),
	genericAgent({
		slug: 'warp',
		name: 'Warp',
		icon: 'warp',
		pitch:
			'Give Warp\u2019s agents the same credentials, packages, and workflows the rest of your team uses.',
	}),
	genericAgent({
		slug: 'goose',
		name: 'Goose',
		icon: 'goose',
		pitch:
			'Point Goose at Kody, and the tools it builds stay around for the rest of your team.',
	}),
	genericAgent({
		slug: 'zed',
		name: 'Zed',
		icon: 'zed',
		pitch:
			'Bring your team\u2019s credentials, packages, and workflows into Zed\u2019s agent panel.',
	}),
	genericAgent({
		slug: 'pi',
		name: 'Pi',
		icon: 'pi',
		pitch:
			'Give Pi the shared credentials and workflows your team keeps in Kody.',
	}),
	genericAgent({
		slug: 'wajo',
		name: 'Wajo',
		icon: 'wajo',
		pitch:
			'Reach your team\u2019s packages and connected accounts from Wajo, wherever you chat.',
	}),
	genericAgent({
		slug: 'cue',
		name: 'Cue',
		icon: 'cue',
		pitch:
			'Let your Cue agents use your team\u2019s tools and connected accounts without ever seeing a key.',
	}),
	{
		slug: 'openmuse',
		name: 'OpenMuse',
		icon: 'openmuse',
		official: false,
		note: 'OpenMuse has no settings screen for MCP servers, so Kody connects through the harness behind your OpenMuse deployment. A chat prompt alone cannot add it.',
		pitch:
			'Wire Kody into your OpenMuse harness so the work it does reaches the rest of your team.',
		steps: [
			{
				text: 'Register Kody as an MCP server in the harness behind your OpenMuse fork. The guide covers both ways to wire it in.',
				link: { label: 'Read OpenMuse and Kody', href: '/docs/openmuse' },
			},
			{
				text: 'Point the harness at this URL (Streamable HTTP with OAuth sign-in):',
				code: mcpUrl,
			},
			{
				text: 'Once the harness is wired up, paste this setup prompt into OpenMuse to sign in and get started.',
				prompt: true,
			},
		],
	},
	genericAgent({
		slug: 'dots',
		name: 'Dots',
		icon: 'dots',
		pitch:
			'Bring your team\u2019s tools and connected accounts into Dots through one MCP connection.',
	}),
] as const satisfies ReadonlyArray<WithAgent>

export type WithAgentSlug = (typeof withAgents)[number]['slug']

export function findWithAgent(slug: string): WithAgent | null {
	return withAgents.find((agent) => agent.slug === slug) ?? null
}

export function withAgentHref(slug: string) {
	return `/with/${slug}`
}

export function findWithAgentByPathname(pathname: string): WithAgent | null {
	const slug = /^\/with\/([^/]+)\/?$/.exec(pathname)?.[1]
	return slug ? findWithAgent(slug) : null
}

export function withAgentIconSrc(agent: Pick<WithAgent, 'icon'>) {
	return `/images/icons/${agent.icon}.svg`
}

/** One SSR shuffle for the homepage marquee, carried in loader data so hydrate matches. */
export function pickWithAgentOrder(
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): Array<WithAgentSlug> {
	return shuffleOnboardingAgentIds(
		withAgents.map((agent) => agent.slug),
		randomInt,
	)
}

/** Loader data is untrusted; keep only known slugs and fill in any missing ones. */
export function resolveWithAgentOrder(
	order: ReadonlyArray<string> | null | undefined,
): Array<WithAgent> {
	const seen = new Set<string>()
	const ordered: Array<WithAgent> = []
	for (const slug of order ?? []) {
		const agent = findWithAgent(slug)
		if (!agent || seen.has(slug)) continue
		seen.add(slug)
		ordered.push(agent)
	}
	for (const agent of withAgents) {
		if (!seen.has(agent.slug)) ordered.push(agent)
	}
	return ordered
}
