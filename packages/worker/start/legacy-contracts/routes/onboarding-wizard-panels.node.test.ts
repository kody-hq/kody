import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { defaultKodyMcpUrl } from '../../../client/routes/onboarding-mcp-clients.ts'
import {
	renderAccessPanel,
	renderConnectAgentPanel,
	renderSecondAgentPanel,
} from '../../pages/onboarding-wizard-panels.tsx'

type ConnectProps = Parameters<typeof renderConnectAgentPanel>[0]
type AccessProps = Parameters<typeof renderAccessPanel>[0]
type SecondProps = Parameters<typeof renderSecondAgentPanel>[0]

const shared = {
	entrance: () => {},
	onSelectStep() {},
	agentChooser: null,
	mcpServerUrl: defaultKodyMcpUrl,
	mcpHighlights: {},
}

const connectPanel = (props: Partial<ConnectProps>) =>
	renderToString(
		renderConnectAgentPanel({
			...shared,
			activeStep: 1,
			loggedIn: false,
			hasMcpClient: false,
			selectedAgent: null,
			selectedAgentLabel: null,
			...props,
		}),
	)

const accessPanel = (props: Partial<AccessProps>) =>
	renderToString(
		renderAccessPanel({
			...shared,
			activeStep: 2,
			hasMcpClient: false,
			hasAccessWin: false,
			discoveryPrompt:
				"I'm deciding whether Kody (https://example.com) would be useful for me. Read https://example.com/docs/what-is-kody and then interview me to find out what Kody could do for me.",
			selectedAgentLabel: null,
			...props,
		}),
	)

const secondAgentPanel = (props: Partial<SecondProps>) =>
	renderToString(
		renderSecondAgentPanel({
			...shared,
			activeStep: 3,
			loggedIn: true,
			hasSecondMcpClient: false,
			firstAgent: 'codex',
			selectedAgent: null,
			selectedAgentLabel: null,
			...props,
		}),
	)

const missing = (html: string | undefined, parts: Array<string>) =>
	parts.filter((part) => !html?.includes(part))

const cursor = {
	selectedAgent: 'cursor',
	selectedAgentLabel: 'Cursor',
} as const
const cursorAwaiting = {
	...cursor,
	loggedIn: true,
	hasMcpClient: true,
	awaitingConnect: true,
} as const
const claudeDesktop = {
	selectedAgent: 'claude-desktop',
	selectedAgentLabel: 'Claude Desktop',
	loggedIn: true,
	hasMcpClient: true,
} as const
const claudeCode = {
	selectedAgent: 'claude-code',
	selectedAgentLabel: 'Claude Code',
} as const

test('step 1 title names the selected agent and offers a text change link', async () => {
	const picker = await connectPanel({})
	expect(
		missing(picker, [
			'Connect your agent',
			'href="/onboarding/step-1/cursor"',
			'data-testid="onboarding-wizard-next"',
		]),
	).toEqual([])

	expect(
		missing(await connectPanel(cursor), [
			'Connect Cursor',
			'data-testid="onboarding-agent-change"',
			'href="/onboarding/step-1"',
			'Log in to connect Cursor',
		]),
	).toEqual([])

	const connected = await connectPanel({
		...cursor,
		loggedIn: true,
		hasMcpClient: true,
		connectedAgents: [
			{ label: 'Cursor', kind: 'cursor' },
			{ label: 'Claude Desktop', kind: 'claude-desktop' },
		],
	})
	expect(
		missing(connected, [
			'Cursor is connected',
			'data-testid="onboarding-connected-agents"',
			'data-agent-kind="cursor"',
		]),
	).toEqual([])
	expect(connected).not.toContain('data-agent-kind="claude-desktop"')

	const claudeWhileChatGpt = await connectPanel({
		...claudeDesktop,
		connectedAgents: [{ label: 'ChatGPT.com', kind: 'chatgpt' }],
	})
	expect(claudeWhileChatGpt).not.toContain('data-connected="true"')
	expect(claudeWhileChatGpt).not.toContain('ChatGPT.com')
	expect(claudeWhileChatGpt).not.toContain(
		'data-testid="onboarding-connected-agents"',
	)
	expect(claudeWhileChatGpt).toContain('data-testid="onboarding-wizard-next"')
	expect(await connectPanel(claudeDesktop)).not.toContain(
		'data-connected="true"',
	)

	const waitingToConnect = await connectPanel({
		...cursor,
		loggedIn: true,
		awaitingConnect: true,
	})
	expect(waitingToConnect).toContain('data-testid="onboarding-connect-wait"')
	expect(waitingToConnect).toContain('Waiting for Cursor to connect')
	expect(waitingToConnect).not.toContain('data-testid="onboarding-wizard-next"')

	// Cursor Local / Cloud grants satisfy the Cursor card; Grok Bot does not.
	const cursorLocalGrant = await connectPanel({
		...cursorAwaiting,
		connectedAgents: [{ label: 'Cursor Local', kind: 'cursor-local' }],
	})
	expect(cursorLocalGrant).toContain('Cursor is connected')
	expect(cursorLocalGrant).toContain('data-testid="onboarding-wizard-next"')
	expect(cursorLocalGrant).not.toContain('Waiting for Cursor to connect')

	const cursorCloudGrant = await connectPanel({
		...cursorAwaiting,
		connectedAgents: [{ label: 'Cursor Cloud', kind: 'cursor-cloud' }],
	})
	expect(cursorCloudGrant).toContain('Cursor is connected')
	expect(cursorCloudGrant).not.toContain('Waiting for Cursor to connect')

	const grokBotOnCursorCard = await connectPanel({
		...cursorAwaiting,
		connectedAgents: [{ label: 'Grok Bot', kind: 'grok-bot' }],
	})
	expect(grokBotOnCursorCard).toContain('Waiting for Cursor to connect')
	expect(grokBotOnCursorCard).not.toContain(
		'data-testid="onboarding-wizard-next"',
	)
})

test('step 2 shows one prompt and a search waiting spinner', async () => {
	const unconnected = await accessPanel({})
	expect(unconnected).toContain('data-testid="onboarding-wizard-next"')
	expect(unconnected).toContain('data-testid="onboarding-unconnected-prompt"')
	expect(unconnected).not.toContain('data-onboarding-connect-action')

	const waiting = await accessPanel({
		hasMcpClient: true,
		selectedAgentLabel: 'Cursor',
		connectedAgents: [
			{ label: 'Cursor', kind: 'cursor' },
			{ label: 'Claude Desktop', kind: 'claude-desktop' },
		],
	})
	expect(
		missing(waiting, [
			'data-testid="onboarding-step-2-prompt"',
			'data-testid="onboarding-search-status"',
			'data-testid="onboarding-guide-pointer"',
			'data-testid="onboarding-wizard-next"',
			'data-testid="onboarding-connected-agents"',
		]),
	).toEqual([])
	expect(waiting).not.toContain('data-connected="true"')

	const started = await accessPanel({
		hasMcpClient: true,
		hasAccessWin: true,
		selectedAgentLabel: 'Cursor',
	})
	expect(started).toContain('data-testid="onboarding-search-status"')
	expect(started).toContain('data-connected="true"')
})

test('step 3 groups ecosystems and folds in a portability proof', async () => {
	const picker = await secondAgentPanel({})
	expect(
		missing(picker, [
			'Connect a second agent',
			'Pro free for 2 weeks',
			'data-picker="ecosystem"',
			'data-testid="onboarding-ecosystem-xai"',
			'data-testid="onboarding-ecosystem-openai"',
			'data-testid="onboarding-agent-chatgpt"',
			'href="/onboarding/step-3/claude-code"',
			'href="/onboarding/step-3/cursor-local"',
			'href="/onboarding/step-3/cursor-cloud"',
			'href="/onboarding/step-3/chatgpt"',
			'href="/onboarding/step-3/codex"',
			'href="/community"',
		]),
	).toEqual([])
	const grokSection = picker.slice(
		picker.indexOf('data-testid="onboarding-ecosystem-xai"'),
		picker.indexOf('data-testid="onboarding-ecosystem-anthropic"'),
	)
	expect(
		missing(grokSection, [
			'>Grok<',
			'Cursor Local',
			'Cursor Cloud',
			'Grok Bot',
			'Grok.com',
			'Grok CLI',
		]),
	).toEqual([])
	expect(picker).not.toContain('data-greyed="true"')
	expect(picker).not.toContain('data-testid="onboarding-portability-proof"')
	expect(picker).not.toContain('data-testid="onboarding-access-win-made"')

	expect(
		await secondAgentPanel({
			accessWinMemorySubject: 'Preferred commute',
			persistedPackageName: '@you/morning-digest',
		}),
	).toContain('data-testid="onboarding-access-win-made"')

	const selected = await secondAgentPanel(claudeCode)
	expect(
		missing(selected, [
			'Connect Claude Code',
			'data-testid="onboarding-wizard-explore-packages"',
			'data-testid="onboarding-portability-proof"',
			'data-testid="onboarding-portability-guide-pointer"',
			'href="/docs/portability"',
		]),
	).toEqual([])
	expect(selected).not.toContain('Waiting for Claude Code to connect')

	const waitingForSecond = await secondAgentPanel({
		...claudeCode,
		awaitingConnect: true,
	})
	expect(waitingForSecond).toContain('data-testid="onboarding-connect-wait"')
	expect(waitingForSecond).toContain('Waiting for Claude Code to connect')
	expect(waitingForSecond).not.toContain(
		'data-testid="onboarding-wizard-explore-packages"',
	)

	const secondConnected = {
		...claudeCode,
		hasSecondMcpClient: true,
		connectedAgents: [{ label: 'Claude Code', kind: 'claude-code' }],
	} as const
	const connected = await secondAgentPanel(secondConnected)
	expect(connected).toContain('You&#x27;ve connected a second agent.')
	expect(connected).not.toContain('Pro is free for 2 weeks')
	expect(
		await secondAgentPanel({ ...secondConnected, secondAgentGiftActive: true }),
	).toContain('You&#x27;ve connected a second agent. Pro is free for 2 weeks.')

	const labeled = await secondAgentPanel({
		firstAgent: 'gemini',
		hasSecondMcpClient: true,
		connectedAgents: [
			{ label: 'Devin', kind: 'devin' },
			{ label: 'Claude Desktop', kind: 'claude-desktop' },
			{ label: 'ChatGPT.com', kind: 'chatgpt' },
			{ label: 'Codex', kind: 'codex' },
			{ label: 'Cursor', kind: 'cursor' },
			{ label: 'Grok.com', kind: 'grok' },
			{ label: 'Kody' },
			{ label: 'Copilot', kind: 'copilot' },
			{ label: 'Grok CLI', kind: 'grok-cli' },
			{ label: 'Zephyr' },
		],
	})
	expect(
		missing(labeled, [
			'data-testid="onboarding-connected-agents"',
			'aria-label="Connected: Devin, Claude Desktop',
			'data-agent-kind="devin"',
			'data-agent-kind="unknown"',
			'/images/icons/devin.svg',
			'/images/icons/claude.svg',
			'/images/icons/chatgpt.svg',
			'/images/icons/cursor.svg',
			'/images/icons/githubcopilot.svg',
			'data-greyed-reason="connected"',
			'data-testid="onboarding-agent-gemini"',
			'data-testid="onboarding-agent-cursor-local"',
			'data-testid="onboarding-agent-chatgpt"',
			'data-testid="onboarding-agent-devin"',
			'href="/onboarding/step-3/gemini"',
			'href="/onboarding/step-3/cursor-local"',
			'href="/onboarding/step-3/cursor-cloud"',
			// Already-connected hosts stay links so connect steps can be re-viewed.
			'href="/onboarding/step-3/chatgpt"',
			'href="/onboarding/step-3/devin"',
			'href="/onboarding/step-3/codex"',
			'href="/onboarding/step-3/copilot"',
			'href="/onboarding/step-3/claude-code"',
			'href="/onboarding/step-3/grok-bot"',
			'Already connected. Select to view connect steps again.',
		]),
	).toEqual([])
	expect(labeled).toMatch(
		/<a(?=[^>]*href="\/onboarding\/step-3\/codex")(?=[^>]*data-greyed="true")[^>]*>/,
	)
	expect(labeled).toMatch(
		/<a(?=[^>]*href="\/onboarding\/step-3\/chatgpt")(?=[^>]*data-greyed-reason="connected")[^>]*>/,
	)
	const connectedLine = labeled.match(
		/data-testid="onboarding-connected-agents"[\s\S]*?<\/p>/,
	)?.[0]
	expect(connectedLine).toContain('data-mark-size="inline"')
	const markClass = connectedLine?.match(
		/data-mark-size="inline" class="([^"]+)"/,
	)?.[1]
	expect(markClass).toBeTruthy()
	const markCss = labeled.match(new RegExp(`\\.${markClass}\\{([^}]+)\\}`))?.[1]
	expect(markCss).toBeDefined()
	expect(markCss).toContain('display:inline-block')
	expect(markCss).toContain('width:1cap')
	expect(markCss).toContain('height:1cap')
	expect(markCss).toContain('vertical-align:baseline')
	const githubSection = labeled.slice(
		labeled.indexOf('data-testid="onboarding-ecosystem-github"'),
		labeled.indexOf('data-testid="onboarding-ecosystem-google"'),
	)
	expect(
		missing(githubSection, [
			'>GitHub<',
			'Copilot App',
			'data-testid="onboarding-agent-copilot-app"',
		]),
	).toEqual([])

	const notListedDeepLink = await secondAgentPanel({
		connectedAgents: [{ label: 'Zephyr' }, { label: 'Kody' }],
		firstAgent: 'other',
		selectedAgent: 'other',
		selectedAgentLabel: 'Not listed',
	})
	expect(notListedDeepLink).toContain('data-picker="ecosystem"')
	expect(notListedDeepLink).toContain('data-agent-kind="unknown"')
	expect(notListedDeepLink).not.toContain('data-greyed="true"')
})
