/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'

import {
	type McpClientKind,
	type OnboardingAgentSurface,
	codexMcpLoginCommand,
	hermesMcpLoginCommand,
	isDefaultKodyMcpUrl,
	museMcpLoginCommand,
	openClawMcpLoginCommand,
	openCodeMcpAuthCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'

export function AgentAuthCallout(props: {
	agent: McpClientKind
	surface: OnboardingAgentSurface
	mcpServerUrl: string
}) {
	return (
		<div
			css={authNoteCss}
			role="note"
			data-testid="onboarding-authenticate-callout"
		>
			<strong>Authenticate Kody before you continue</strong>
			<span>
				{renderAgentAuthHint(props.agent, props.surface, props.mcpServerUrl)}
			</span>
			<span>
				Approve the <strong>{new URL(props.mcpServerUrl).host}</strong> OAuth
				window. This is the step that connects your agent to your factory.
			</span>
		</div>
	)
}

function renderAgentAuthHint(
	kind: McpClientKind,
	surface: OnboardingAgentSurface,
	mcpServerUrl: string,
) {
	const productionPlugin = isDefaultKodyMcpUrl(mcpServerUrl)
	switch (kind) {
		case 'cursor-local':
			return (
				<>
					Open Cursor on this computer, add the plugin, then click{' '}
					<strong>Authenticate</strong> in the MCP list.
				</>
			)
		case 'cursor-cloud':
			return (
				<>
					Open a Cursor cloud agent, add the plugin, then click{' '}
					<strong>Authenticate</strong>. Grok Bot uses this connection.
				</>
			)
		case 'cursor':
			return surface === 'mobile' ? (
				<>
					After installing the plugin, open Cursor on the web and complete{' '}
					<strong>Authenticate</strong> if it asks.
				</>
			) : (
				<>
					After installing the plugin, open the Cursor MCP list and click{' '}
					<strong>Authenticate</strong>.
				</>
			)
		case 'claude-code':
			return surface === 'mobile' ? (
				<>Complete OAuth in the Claude app under Settings → Connectors.</>
			) : (
				<>
					After install, enter <code>/mcp</code> → Kody →{' '}
					<strong>Authenticate</strong>.
				</>
			)
		case 'chatgpt':
			return productionPlugin ? (
				<>Complete OAuth when ChatGPT prompts you after adding the plugin.</>
			) : (
				<>Complete OAuth when ChatGPT prompts you after creating the app.</>
			)
		case 'codex':
			if (surface === 'mobile') {
				return productionPlugin ? (
					<>
						Complete OAuth when the ChatGPT app prompts you after adding the
						plugin.
					</>
				) : (
					<>Complete OAuth when the ChatGPT app prompts you.</>
				)
			}
			return productionPlugin ? (
				<>
					After adding the plugin, complete OAuth when ChatGPT prompts you. If
					you used the Codex CLI instead, run{' '}
					<code>{codexMcpLoginCommand}</code>.
				</>
			) : (
				<>
					Run <code>{codexMcpLoginCommand}</code> if OAuth does not start
					automatically.
				</>
			)
		case 'claude-desktop':
			return <>Complete OAuth in Settings → Connectors.</>
		case 'grok':
			return (
				<>Complete OAuth when Grok prompts you after adding the connector.</>
			)
		case 'grok-cli':
			return surface === 'mobile' ? (
				<>
					Authenticate on a computer. In the TUI, <code>/mcps</code> then{' '}
					<strong>i</strong>. Or change selection and choose{' '}
					<strong>Grok Bot</strong>.
				</>
			) : (
				<>
					OAuth opens on first use. In the TUI, <code>/mcps</code> then{' '}
					<strong>i</strong> authenticates. <code>grok mcp doctor kody</code>{' '}
					checks the connection.
				</>
			)
		case 'grok-bot':
			return surface === 'mobile' ? (
				<>
					After adding the plugin, complete <strong>Authorize</strong> when Grok
					Bot prompts you on your phone or on a computer.
				</>
			) : (
				<>
					After adding the plugin, complete <strong>Authorize</strong> when Grok
					Bot prompts you.
				</>
			)
		case 'opencode':
			return surface === 'mobile' ? (
				<>Authenticate on a computer if prompted.</>
			) : (
				<>
					Run <code>{openCodeMcpAuthCommand}</code> if prompted.
				</>
			)
		case 'openclaw':
			return surface === 'mobile' ? (
				<>
					Save the server in the Control UI, then run{' '}
					<code>{openClawMcpLoginCommand}</code> on a computer. Approve the Kody
					OAuth window.
				</>
			) : (
				<>
					Run <code>{openClawMcpLoginCommand}</code> after the server is saved.
					Approve the Kody OAuth window.
				</>
			)
		case 'hermes':
			return surface === 'mobile' ? (
				<>
					On the computer that runs Hermes, run the <code>hermes mcp add</code>{' '}
					command and approve the Kody OAuth window it opens.
				</>
			) : (
				<>
					<code>hermes mcp add</code> opens the sign-in while it tests the
					connection. If you edited <code>config.yaml</code> instead, run{' '}
					<code>{hermesMcpLoginCommand}</code>.
				</>
			)
		case 'muse':
			return surface === 'mobile' ? (
				<>
					On a computer, merge Kody into{' '}
					<code>~/.config/muse/settings.json</code>, run{' '}
					<code>{museMcpLoginCommand}</code>, then complete OAuth. After OAuth
					succeeds, you may need to paste a localhost URL into the Muse chat.
				</>
			) : (
				<>
					Run <code>{museMcpLoginCommand}</code> after saving{' '}
					<code>~/.config/muse/settings.json</code>, then complete OAuth when
					prompted. After OAuth succeeds, you may need to paste a localhost URL
					into the Muse chat.
				</>
			)
		case 'wajo':
		case 'cue':
		case 'openmuse':
		case 'dots':
			return <>Complete OAuth when the host opens it.</>
		case 'copilot':
			return surface === 'mobile' ? (
				<>Complete OAuth when the GitHub or Copilot app opens it.</>
			) : (
				<>Complete OAuth when VS Code or Copilot CLI opens it.</>
			)
		case 'copilot-app':
			return <>Complete OAuth when the Copilot app opens it.</>
		case 'devin':
			return <>Complete OAuth when Devin opens it.</>
		case 'gemini':
			return <>Complete OAuth when Gemini or Jules prompts you.</>
		case 'other':
			return <>Complete OAuth when the host opens it.</>
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

const authNoteCss: CSSObject = {
	...getAccentCalloutCss({ accentColor: colors.primary }),
	gap: '0.55rem',
	padding: '1.2rem 1.35rem',
	borderLeftWidth: '6px',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.14)`,
	boxShadow: `0 10px 28px oklch(from ${colors.primary} l c h / 0.12)`,
	'& > strong': {
		font: `750 1.2rem/1.15 ${typography.fontFamilyDisplay}`,
		color: colors.primaryText,
	},
	'& > span': {
		color: colors.text,
		lineHeight: 1.5,
	},
	'& code': {
		font: '600 0.9em ui-monospace, "SF Mono", Menlo, monospace',
	},
}
