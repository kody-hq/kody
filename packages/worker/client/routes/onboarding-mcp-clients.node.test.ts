import { expect, test } from 'vitest'
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
	buildKodyCliInstallCommand,
	buildMuseSettingsJson,
	buildOpenClawMcpAddCommand,
	buildOpenClawMcpJson,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	defaultKodyMcpUrl,
	isDefaultKodyMcpUrl,
	mcpClientTabs,
	onboardingDataHref,
	onboardingDesktopFeaturedAgentIds,
	onboardingMobileFeaturedAgentIds,
	onboardingMoreAgentIdsFor,
	onboardingMobileAgentMq,
	onboardingViewportCss,
	pickOnboardingAgentChooser,
} from './onboarding-mcp-clients.ts'

const mcpServerUrl = defaultKodyMcpUrl

test('onboarding MCP client builders emit the structured configs each host expects', () => {
	const tabIds = mcpClientTabs.map((tab) => tab.id)
	expect(new Set(tabIds).size).toBe(tabIds.length)
	expect(onboardingMoreAgentIdsFor('desktop')).not.toContain(
		onboardingDesktopFeaturedAgentIds[0],
	)
	expect(onboardingMoreAgentIdsFor('mobile')).not.toContain(
		onboardingMobileFeaturedAgentIds[0],
	)
	const rotated = pickOnboardingAgentChooser(() => 0)
	const identity = pickOnboardingAgentChooser((max) => max - 1)
	expect(rotated.desktopFeatured).not.toEqual(identity.desktopFeatured)
	expect(rotated.mobileFeatured).not.toEqual(identity.mobileFeatured)
	expect(onboardingDataHref('/onboarding/step-1/cursor?redirectTo=%2F')).toBe(
		'/onboarding?redirectTo=%2F',
	)
	expect(onboardingDataHref('/onboarding/step-2/notion#unused')).toBe(
		'/onboarding',
	)
	expect(onboardingViewportCss('desktop-only', 'list-item')).toEqual({
		display: 'list-item',
		[onboardingMobileAgentMq]: { display: 'none' },
	})
	expect(onboardingViewportCss('mobile-only', 'list-item')).toEqual({
		display: 'none',
		[onboardingMobileAgentMq]: { display: 'list-item' },
	})

	expect(isDefaultKodyMcpUrl(`${mcpServerUrl}/`)).toBe(true)
	expect(isDefaultKodyMcpUrl('http://localhost:3742/mcp')).toBe(false)
	for (const url of [mcpServerUrl, `${mcpServerUrl}/`]) {
		expect(buildKodyCliInstallCommand(url)).toBe('npx @kodycodes/cli install')
	}
	expect(buildKodyCliInstallCommand('http://localhost:3742/mcp')).toBe(
		'npx @kodycodes/cli install --mcp-url http://localhost:3742/mcp',
	)

	const httpKody = { kody: { type: 'http', url: mcpServerUrl } }
	expect(JSON.parse(buildClaudeCodeMcpJson(mcpServerUrl))).toEqual({
		mcpServers: httpKody,
	})
	expect(buildClaudeCodeAddCommand(mcpServerUrl)).toBe(
		`claude mcp add --transport http -s user kody ${mcpServerUrl}`,
	)
	expect(buildCodexMcpAddCommand(mcpServerUrl)).toBe(
		`codex mcp add kody --url ${mcpServerUrl}`,
	)
	expect(buildCodexMcpDeepLink(mcpServerUrl)).toBe(
		`codex://mcp/add?name=kody&url=${encodeURIComponent(mcpServerUrl)}`,
	)
	expect(buildOpenCodeMcpAddCommand(mcpServerUrl)).toBe(
		`opencode mcp add kody --url ${mcpServerUrl}`,
	)
	expect(JSON.parse(buildVsCodeMcpJson(mcpServerUrl))).toEqual({
		servers: httpKody,
	})
	expect(buildCopilotCliAddCommand(mcpServerUrl)).toBe(
		`copilot mcp add --transport http kody ${mcpServerUrl}`,
	)
	expect(JSON.parse(buildCopilotCliMcpJson(mcpServerUrl))).toEqual({
		mcpServers: httpKody,
	})
	expect(JSON.parse(buildOpenCodeMcpJson(mcpServerUrl))).toEqual({
		mcp: {
			kody: {
				type: 'remote',
				url: mcpServerUrl,
				enabled: true,
			},
		},
	})
	expect(buildOpenClawMcpAddCommand(mcpServerUrl)).toBe(
		`openclaw mcp add kody --url ${mcpServerUrl} --transport streamable-http --auth oauth`,
	)
	expect(JSON.parse(buildOpenClawMcpJson(mcpServerUrl))).toEqual({
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
	expect(buildHermesMcpAddCommand(mcpServerUrl)).toBe(
		`hermes mcp add kody --url ${mcpServerUrl} --auth oauth`,
	)
	expect(buildHermesMcpYaml(mcpServerUrl)).toBe(
		`mcp_servers:\n  kody:\n    url: "${mcpServerUrl}"\n    auth: oauth\n`,
	)
	expect(JSON.parse(buildMuseSettingsJson(mcpServerUrl))).toEqual({
		schema_version: 1,
		mcp_servers: {
			kody: {
				transport: 'streamable_http',
				url: mcpServerUrl,
				mode: 'optional',
			},
		},
	})
	const kodyToml = `[mcp_servers.kody]\nurl = "${mcpServerUrl}"\n`
	expect(buildCodexMcpToml(mcpServerUrl)).toBe(kodyToml)
	expect(buildGrokCliAddCommand(mcpServerUrl)).toBe(
		`grok mcp add --transport http --scope user kody ${mcpServerUrl}`,
	)
	expect(buildGrokCliMcpToml(mcpServerUrl)).toBe(kodyToml)
	expect(buildKodyAppIconUrl(mcpServerUrl)).toBe(
		'https://kody.codes/images/kody-app-icon.png',
	)

	const vsCodeInstallUrl = buildVsCodeInstallUrl(mcpServerUrl)
	expect(vsCodeInstallUrl.startsWith('vscode:mcp/install?')).toBe(true)
	expect(
		JSON.parse(
			decodeURIComponent(vsCodeInstallUrl.slice('vscode:mcp/install?'.length)),
		),
	).toEqual({
		name: 'kody',
		type: 'http',
		url: mcpServerUrl,
	})
})
