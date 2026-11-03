import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
} from '#worker/onboarding-prompts.ts'
import type { McpRegistrationAgent } from './mcp-registration-agent.ts'

function textPromptResult(input: { description: string; text: string }) {
	return {
		description: input.description,
		messages: [
			{
				role: 'user' as const,
				content: {
					type: 'text' as const,
					text: input.text,
				},
			},
		],
	}
}

/**
 * Register the templated onboarding prompts so MCP clients (Claude, etc.)
 * can list/get them natively. Keep the tool surface compact — these are
 * user-invoked prompts, not new tools.
 */
export async function registerPrompts(agent: McpRegistrationAgent) {
	agent.server.registerPrompt(
		'onboarding_setup',
		{
			title: 'Kody setup',
			description:
				'Get started with Kody: explain what it can do, give Kody access to one service, verify with execute, then persist a package they own.',
		},
		() =>
			textPromptResult({
				description: 'Kody onboarding setup prompt',
				text: buildOnboardingSetupPrompt(),
			}),
	)

	agent.server.registerPrompt(
		'onboarding_discovery',
		{
			title: 'Is Kody useful for me?',
			description:
				'Pre-account discovery interview. Asks the agent to read the what-is-kody guide and interview you — no setup yet.',
		},
		() => {
			const requestUrl = agent.requireDomain()
			return textPromptResult({
				description: 'Kody discovery prompt',
				text: buildDiscoveryPrompt({
					env: agent.getEnv(),
					requestUrl,
				}),
			})
		},
	)

	agent.server.registerPrompt(
		'onboarding_quick_example',
		{
			title: 'First build',
			description:
				'Onboarding Step 3: run one ad hoc execute against a connected MCP server, persist that working code as a package, explain ownership, offer optional triggers. No polling.',
		},
		() => {
			const requestUrl = agent.requireDomain()
			return textPromptResult({
				description: 'Kody first-build persist prompt',
				text: buildPersistFirstPackagePrompt({
					env: agent.getEnv(),
					requestUrl,
				}),
			})
		},
	)

	agent.server.registerPrompt(
		'onboarding_first_win',
		{
			title: 'Email and memories',
			description:
				'Optional email loop: send a welcome email, wait for the person to reply from their inbox, then look it up and save memories. No polling.',
		},
		() => {
			const requestUrl = agent.requireDomain()
			return textPromptResult({
				description: 'Kody first-win prompt',
				text: buildFirstWinPrompt({
					env: agent.getEnv(),
					requestUrl,
				}),
			})
		},
	)
}
