/** @jsxImportSource @emotion/react */

import { SiteLink } from '../components/site-link.tsx'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpDeepLink,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildGrokCliAddCommand,
	buildGrokCliMcpToml,
	buildHermesMcpAddCommand,
	buildHermesMcpYaml,
	buildKodyAppIconUrl,
	buildOpenClawMcpAddCommand,
	buildOpenClawMcpJson,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildMuseSettingsJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	chatGptCustomMcpFallbackNote,
	chatGptCustomMcpGuideUrl,
	chatGptDirectoryListingNote,
	chatGptPluginManagementGuideUrl,
	codexPluginInstallCommands,
	isDefaultKodyMcpUrl,
	kodyPluginMarketplaceSource,
	kodyPluginPreviewNote,
	kodyPluginReadmeUrl,
	kodyPluginSideloadSteps,
	claudeDesktopToolHint,
	cueSiteUrl,
	dotsIntroUrl,
	grokBotInstallUrl,
	grokConnectorsUrl,
	hermesMcpGuideUrl,
	hermesMcpLoginCommand,
	hermesMcpTokensPath,
	buildKodyCliLoginCommand,
	instinctSiteUrl,
	kodyCliGlobalInstallCommand,
	kodyAppIconFilename,
	kodyBotTemplateLabel,
	kodyBotTemplateSummary,
	kodyBotTemplateUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
	type McpClientKind,
	type OnboardingAgentSurface,
	museMcpGuideUrl,
	museMcpLoginCommand,
	openClawMcpLoginCommand,
	openMuseGuideUrl,
	wajoSiteUrl,
} from '#client/routes/onboarding-mcp-clients.ts'
import type { HighlightedCode } from '#universal/highlighted-code.ts'
import {
	AppIconCard,
	ChatGptSideloadNote,
	ClientWarning,
	CopyCard,
	CopyCardDetails,
	InstallDeepLink,
	OnboardingManualDetails,
	PluginPrimaryInstall,
	PrimaryActionLink,
	SideloadSteps,
} from './onboarding-mcp-client-cards.tsx'

function ConnectCopyCard(props: {
	label: string
	value: string
	copyLabel: string
	variant?: 'pill' | 'ghost'
	lang?: string | null
	highlights?: Record<string, HighlightedCode>
}) {
	return (
		<CopyCard
			highlights={props.highlights}
			label={props.label}
			value={props.value}
			copyLabel={props.copyLabel}
			variant={props.variant}
			lang={props.lang}
			signalsConnectAction
		/>
	)
}

function ConnectCopyCardDetails(props: {
	label: string
	value: string
	copyLabel: string
	summaryLead: string
	summaryCode?: string
	variant?: 'pill' | 'ghost'
	lang?: string | null
	highlights?: Record<string, HighlightedCode>
}) {
	return (
		<CopyCardDetails
			highlights={props.highlights}
			summaryLead={props.summaryLead}
			summaryCode={props.summaryCode}
			label={props.label}
			value={props.value}
			copyLabel={props.copyLabel}
			variant={props.variant}
			lang={props.lang}
			signalsConnectAction
		/>
	)
}

/**
 * Sideload Kody from our plugin marketplace (`kody-hq/kody`). The ChatGPT and
 * Codex apps share installed plugins. Codex adds the CLI commands first.
 */
function KodyPluginMarketplaceSideload(props: {
	host: 'chatgpt' | 'codex'
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
}) {
	return (
		<>
			{props.host === 'codex' ? (
				<>
					<SideloadSteps steps={[kodyPluginSideloadSteps.codexCli]} />
					<ConnectCopyCard
						highlights={props.highlights}
						label="Codex CLI"
						value={codexPluginInstallCommands}
						copyLabel="Copy commands"
						lang="sh"
					/>
				</>
			) : null}
			<SideloadSteps steps={[kodyPluginSideloadSteps.addMarketplace]} />
			<ConnectCopyCard
				highlights={props.highlights}
				label="Add plugin marketplace"
				value={kodyPluginMarketplaceSource}
				copyLabel="Copy source"
			/>
			<SideloadSteps steps={[kodyPluginSideloadSteps.install]} />
			{props.host === 'chatgpt' ? (
				<ChatGptSideloadNote
					availability={kodyPluginSideloadSteps.workspace}
					href={chatGptPluginManagementGuideUrl}
					linkLabel="OpenAI's plugin management guide"
					directoryListing={chatGptDirectoryListingNote}
				/>
			) : (
				<ChatGptSideloadNote
					availability="Every sideload path is in the"
					href={kodyPluginReadmeUrl}
					linkLabel="Kody plugin README"
					directoryListing={chatGptDirectoryListingNote}
				/>
			)}
		</>
	)
}

/**
 * ChatGPT.com custom MCP server with this deployment's MCP URL: the fallback
 * on production, and the only path on preview and local deployments.
 */
function ChatGptCustomMcpServer(props: {
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
	lead: string
}) {
	return (
		<>
			<SideloadSteps steps={[props.lead]} />
			<ConnectCopyCard
				highlights={props.highlights}
				label="MCP URL"
				value={props.mcpServerUrl}
				copyLabel="Copy MCP URL"
			/>
			<AppIconCard
				src={buildKodyAppIconUrl(props.mcpServerUrl)}
				downloadName={kodyAppIconFilename}
			/>
			<p>
				See{' '}
				<SiteLink
					href={chatGptCustomMcpGuideUrl}
					target="_blank"
					rel="noreferrer noopener"
				>
					OpenAI's custom MCP help
				</SiteLink>
				.
			</p>
		</>
	)
}

function CodexMcpServer(props: {
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
}) {
	return (
		<>
			<PrimaryActionLink
				href={buildCodexMcpDeepLink(props.mcpServerUrl)}
				label="Open Codex"
			/>
			<ConnectCopyCard
				highlights={props.highlights}
				label="codex CLI"
				value={buildCodexMcpAddCommand(props.mcpServerUrl)}
				copyLabel="Copy command"
				variant="pill"
				lang="sh"
			/>
			<ConnectCopyCard
				highlights={props.highlights}
				label="~/.codex/config.toml"
				value={buildCodexMcpToml(props.mcpServerUrl)}
				copyLabel="Copy TOML"
				lang="toml"
			/>
		</>
	)
}

export function renderPanelContent(
	kind: McpClientKind,
	mcpServerUrl: string,
	highlights?: Record<string, HighlightedCode>,
	surface: OnboardingAgentSurface = 'desktop',
) {
	switch (kind) {
		case 'cursor':
		case 'cursor-local':
		case 'cursor-cloud':
			return (
				<PluginPrimaryInstall
					href={kodyCursorMarketplaceUrl}
					label={
						kind === 'cursor-cloud'
							? 'Add to Cursor Cloud'
							: kind === 'cursor-local'
								? 'Add to Cursor Local'
								: 'Add to Cursor'
					}
					alternativeValue={kodyCursorAddPluginCommand}
					alternativeCopyLabel="Copy /add-plugin kody"
				/>
			)
		case 'chatgpt':
			if (!isDefaultKodyMcpUrl(mcpServerUrl)) {
				return (
					<ChatGptCustomMcpServer
						mcpServerUrl={mcpServerUrl}
						highlights={highlights}
						lead={`${kodyPluginPreviewNote} On ChatGPT.com with Business, Enterprise, or Edu, add a custom MCP server named Kody with OAuth.`}
					/>
				)
			}
			return (
				<>
					<KodyPluginMarketplaceSideload
						host="chatgpt"
						mcpServerUrl={mcpServerUrl}
						highlights={highlights}
					/>
					<OnboardingManualDetails summaryLead="Or add Kody as a custom MCP server">
						<ChatGptCustomMcpServer
							mcpServerUrl={mcpServerUrl}
							highlights={highlights}
							lead={chatGptCustomMcpFallbackNote}
						/>
					</OnboardingManualDetails>
				</>
			)
		case 'codex': {
			if (!isDefaultKodyMcpUrl(mcpServerUrl)) {
				return (
					<>
						<SideloadSteps steps={[kodyPluginPreviewNote]} />
						<CodexMcpServer
							mcpServerUrl={mcpServerUrl}
							highlights={highlights}
						/>
					</>
				)
			}
			const sideload = (
				<KodyPluginMarketplaceSideload
					host="codex"
					mcpServerUrl={mcpServerUrl}
					highlights={highlights}
				/>
			)
			if (surface === 'mobile') return sideload
			return (
				<>
					{sideload}
					<OnboardingManualDetails summaryLead="Or add Kody as a Codex MCP server only">
						<CodexMcpServer
							mcpServerUrl={mcpServerUrl}
							highlights={highlights}
						/>
					</OnboardingManualDetails>
				</>
			)
		}
		case 'claude-desktop':
			return (
				<ConnectCopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'grok':
			return (
				<>
					<PrimaryActionLink
						href={grokConnectorsUrl}
						label="Open Connectors"
						external
					/>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
					/>
				</>
			)
		case 'grok-cli': {
			const grokCliCommand = buildGrokCliAddCommand(mcpServerUrl)
			const grokCliToml = buildGrokCliMcpToml(mcpServerUrl)
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="grok CLI"
						value={grokCliCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode="~/.grok/config.toml"
						label="~/.grok/config.toml"
						value={grokCliToml}
						copyLabel="Copy TOML"
						lang="toml"
					/>
				</>
			)
		}
		case 'grok-bot':
			return (
				<>
					<PrimaryActionLink
						href={kodyBotTemplateUrl}
						label={kodyBotTemplateLabel}
						external
					/>
					<p data-testid="onboarding-kody-bot-template-summary">
						{kodyBotTemplateSummary}
					</p>
					<OnboardingManualDetails summaryLead="Or add the Kody plugin to a Grok Bot you already use">
						<p>
							<SiteLink
								href={grokBotInstallUrl}
								data-onboarding-connect-action="true"
							>
								Add the Kody plugin to Grok Bot
							</SiteLink>
						</p>
						<p>
							{surface === 'mobile' ? (
								<>
									Or add Kody from <strong>Plugins</strong> on a computer.
								</>
							) : (
								<>
									Or add Kody from <strong>Plugins</strong> in the Grok Bot
									sidebar.
								</>
							)}
						</p>
					</OnboardingManualDetails>
				</>
			)
		case 'claude-code': {
			const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
			const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
			if (surface === 'mobile') {
				return (
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				)
			}
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into a project"
						summaryCode=".mcp.json"
						label=".mcp.json"
						value={claudeCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'opencode': {
			const openCodeCommand = buildOpenCodeMcpAddCommand(mcpServerUrl)
			const openCodeJson = buildOpenCodeMcpJson(mcpServerUrl)
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="opencode CLI"
						value={openCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or add this to"
						summaryCode="opencode.json"
						label="opencode.json"
						value={openCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'openclaw': {
			const openClawCommand = buildOpenClawMcpAddCommand(mcpServerUrl)
			const openClawJson = buildOpenClawMcpJson(mcpServerUrl)
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="openclaw CLI"
						value={openClawCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCard
						highlights={highlights}
						label="openclaw mcp login"
						value={openClawMcpLoginCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode="~/.openclaw/openclaw.json"
						label="~/.openclaw/openclaw.json"
						value={openClawJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'hermes': {
			const hermesCommand = buildHermesMcpAddCommand(mcpServerUrl)
			const hermesYaml = buildHermesMcpYaml(mcpServerUrl)
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="hermes CLI"
						value={hermesCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						Hermes opens the Kody sign-in while it tests the connection, then
						asks which tools to enable. It keeps the tokens in{' '}
						<code>{hermesMcpTokensPath}</code>, not in its config (
						<a href={hermesMcpGuideUrl} target="_blank" rel="noreferrer">
							Hermes MCP docs
						</a>
						).
					</p>
					<OnboardingManualDetails
						summaryLead="Or merge this into"
						summaryCode="~/.hermes/config.yaml"
					>
						<ConnectCopyCard
							highlights={highlights}
							label="~/.hermes/config.yaml"
							value={hermesYaml}
							copyLabel="Copy YAML"
							lang="yaml"
						/>
						<p>Then sign in from a fresh terminal:</p>
						<ConnectCopyCard
							highlights={highlights}
							label="hermes mcp login"
							value={hermesMcpLoginCommand}
							copyLabel="Copy command"
							lang="sh"
						/>
					</OnboardingManualDetails>
				</>
			)
		}
		case 'muse': {
			const museSettingsJson = buildMuseSettingsJson(mcpServerUrl)
			return (
				<>
					<p>
						Add Kody to Muse Code via <code>~/.config/muse/settings.json</code>,
						then sign in with <code>muse mcp login</code> (
						<SiteLink href={museMcpGuideUrl} target="_blank" rel="noreferrer">
							Muse MCP docs
						</SiteLink>
						).
					</p>
					<ConnectCopyCard
						highlights={highlights}
						label="~/.config/muse/settings.json"
						value={museSettingsJson}
						copyLabel="Copy JSON"
						variant="pill"
						lang="json"
					/>
					<ConnectCopyCard
						highlights={highlights}
						label="muse mcp login"
						value={museMcpLoginCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<p>
						After OAuth succeeds, headless Muse may ask you to paste a localhost
						URL into the Muse chat.
					</p>
				</>
			)
		}
		case 'wajo':
			return (
				<>
					<p>
						Wajo (Fo) connects ChatGPT and Claude through Wajo sign-in. Paste
						the MCP URL where Wajo asks for a custom MCP server (
						<SiteLink href={wajoSiteUrl} target="_blank" rel="noreferrer">
							wajo.ai
						</SiteLink>
						).
					</p>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				</>
			)
		case 'cue':
			return (
				<>
					<p>
						Cue is a personal AI agent host (
						<SiteLink href={cueSiteUrl} target="_blank" rel="noreferrer">
							cue.im
						</SiteLink>
						). When Cue exposes a custom MCP connector, paste this URL and
						complete OAuth.
					</p>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				</>
			)
		case 'openmuse':
			return (
				<>
					<p>
						OpenMuse (CopilotKit) does not ship a Kody connector — wire Kody
						into the harness behind your OpenMuse fork. See the{' '}
						<SiteLink href={openMuseGuideUrl}>OpenMuse and Kody</SiteLink>{' '}
						guide.
					</p>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				</>
			)
		case 'dots':
			return (
				<>
					<p>
						Dots is OpenAI&apos;s personal agent (
						<SiteLink href={dotsIntroUrl} target="_blank" rel="noreferrer">
							introducing Dots
						</SiteLink>
						). When Dots exposes a custom MCP connector, paste this URL and
						complete OAuth.
					</p>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				</>
			)
		case 'instinct':
			return (
				<>
					<p>
						Instinct is a personal assistant you text or call (
						<SiteLink href={instinctSiteUrl} target="_blank" rel="noreferrer">
							instinct.com
						</SiteLink>
						). It has no official MCP support, but it can use a computer the way
						you do, so it connects through the Kody CLI. Ask Instinct to run
						these commands on its computer (Node 22 or later). The login prints
						a link and a short code: ask Instinct to send them to you, check
						that the code matches, and approve.
					</p>
					<ConnectCopyCard
						highlights={highlights}
						label="Kody CLI"
						value={`${kodyCliGlobalInstallCommand}\n${buildKodyCliLoginCommand(mcpServerUrl)}`}
						copyLabel="Copy commands"
						lang="sh"
					/>
					<p>
						Then Instinct uses Kody from the CLI: <code>kody search</code> finds
						what your account can do, and <code>kody execute --local</code> runs
						it with your connected accounts. If Instinct adds remote MCP
						support, it can connect to <code>{mcpServerUrl}</code> instead.
					</p>
				</>
			)
		case 'copilot': {
			const vsCodeJson = buildVsCodeMcpJson(mcpServerUrl)
			const installUrl = buildVsCodeInstallUrl(mcpServerUrl)
			const copilotCliCommand = buildCopilotCliAddCommand(mcpServerUrl)
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			if (surface === 'mobile') {
				return (
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				)
			}
			return (
				<>
					<InstallDeepLink href={installUrl} label="Add to VS Code" />
					<p>Or run this for Copilot CLI:</p>
					<ConnectCopyCard
						highlights={highlights}
						label="copilot CLI"
						value={copilotCliCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode=".vscode/mcp.json"
						label=".vscode/mcp.json"
						value={vsCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode="~/.copilot/mcp-config.json"
						label="~/.copilot/mcp-config.json"
						value={copilotCliJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'devin':
			return (
				<ConnectCopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'gemini':
			return (
				<ConnectCopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'copilot-app': {
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					{surface === 'mobile' ? null : (
						<>
							<ConnectCopyCardDetails
								highlights={highlights}
								summaryLead="Or merge this into"
								summaryCode="~/.copilot/mcp-config.json"
								label="~/.copilot/mcp-config.json"
								value={copilotCliJson}
								copyLabel="Copy JSON"
								lang="json"
							/>
						</>
					)}
				</>
			)
		}
		case 'other':
			return (
				<ConnectCopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function renderPanelWarning(
	kind: McpClientKind,
	surface: OnboardingAgentSurface = 'desktop',
) {
	switch (kind) {
		case 'cursor':
		case 'cursor-local':
			return surface === 'mobile' ? (
				<ClientWarning>
					This is not a full editor on a phone. Open cursor.com to kick off and
					check cloud agents.
				</ClientWarning>
			) : null
		case 'chatgpt':
			return surface === 'mobile' ? null : (
				<ClientWarning>
					ChatGPT desktop is Codex. Change selection if you meant that instead.
				</ClientWarning>
			)
		case 'codex':
			return surface === 'mobile' ? (
				<ClientWarning>
					The Codex CLI is for a computer. This URL is for Codex in the ChatGPT
					app.
				</ClientWarning>
			) : null
		case 'claude-desktop':
			return (
				<ClientWarning>
					{`Do not put the remote URL into claude_desktop_config.json. ${claudeDesktopToolHint}`}
				</ClientWarning>
			)
		case 'grok':
			return (
				<ClientWarning>
					Grok CLI and Grok Bot are separate products. Change selection if you
					meant one of those instead.
				</ClientWarning>
			)
		case 'grok-cli':
			return (
				<ClientWarning>
					{surface === 'mobile'
						? 'Grok CLI is a desktop terminal. Change selection and choose Grok Bot, or run these steps later on a computer. Grok.com and Grok Bot are separate products. Change selection if you meant one of those instead.'
						: 'Grok.com and Grok Bot are separate products. Change selection if you meant one of those instead.'}
				</ClientWarning>
			)
		case 'claude-code':
			return surface === 'mobile' ? (
				<ClientWarning>
					The Claude Code CLI is for a computer. This URL is for the Claude app.
				</ClientWarning>
			) : null
		case 'opencode':
			return surface === 'mobile' ? (
				<ClientWarning>
					OpenCode is a desktop terminal. Change selection and pick a host with
					a mobile app, or run these steps later on a computer.
				</ClientWarning>
			) : null
		case 'openclaw':
			return surface === 'mobile' ? (
				<ClientWarning>
					OpenClaw&apos;s browser app works from a phone. You can also run the
					CLI later on a computer.
				</ClientWarning>
			) : null
		case 'hermes':
			return surface === 'mobile' ? (
				<ClientWarning>
					Add Kody on the computer or server that runs Hermes. After that,
					Hermes can use Kody from Telegram, Discord, Slack, and its other
					messaging apps.
				</ClientWarning>
			) : null
		case 'muse':
			return (
				<ClientWarning>
					{surface === 'mobile'
						? "Muse Code is for a computer. Change selection and pick a host with a mobile app, or run these steps later on a computer. Do not paste npx @kodycodes/cli install into Muse chat — that runs in Muse's Linux VM and cannot configure Muse."
						: "Do not paste npx @kodycodes/cli install into Muse chat — that runs in Muse's Linux VM and cannot configure Muse."}
				</ClientWarning>
			)
		case 'wajo':
		case 'cue':
			return surface === 'mobile' ? (
				<ClientWarning>
					Setup is easiest on a computer. Change selection and pick a host with
					a mobile app, or run these steps later on a computer.
				</ClientWarning>
			) : null
		case 'openmuse':
			return (
				<ClientWarning>
					{surface === 'mobile'
						? 'OpenMuse is self-hosted. Wire Kody into your OpenMuse fork on a computer (see the OpenMuse and Kody guide), then use the phone or web app.'
						: 'OpenMuse is distinct from Muse Code. Wire Kody into your OpenMuse fork or AG-UI harness — there is no one-click connector yet.'}
				</ClientWarning>
			)
		case 'dots':
			return surface === 'mobile' ? (
				<ClientWarning>
					Dots setup may need a computer. Change selection and pick a host with
					a mobile app, or run these steps later on a computer.
				</ClientWarning>
			) : null
		case 'cursor-cloud':
		case 'copilot':
		case 'copilot-app':
		case 'devin':
		case 'gemini':
		case 'grok-bot':
		case 'instinct':
		case 'other':
			return null
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
