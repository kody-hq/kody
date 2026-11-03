import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const claudeIntegrations = {
	...acquisitionPageMeta.claudeIntegrations,
	lead: 'Give Claude access to your connected accounts, saved tools, and useful facts through Kody. Build a workflow in one conversation, then use it again from Claude or another connected agent.',
	flow: [
		'Connect Claude to Kody',
		'Connect the services you need',
		'Keep the useful work as a package',
	],
	sections: [
		{
			title: 'Choose a connection method',
			paragraphs: [],
			table: {
				headers: ['Connect through Kody', 'What you can do', 'Get started'],
				rows: [
					[
						'Service accounts',
						'Let Claude work with your connected services',
						'Connect the account and approve the access you need',
					],
					[
						'MCP tools',
						'Discover and combine tools from connected MCP servers',
						'Connect your server to Kody',
					],
					[
						'Saved packages',
						'Run the workflows you built from any connected agent',
						'Save useful code as a package',
					],
				],
			},
		},
		{
			title: 'Connect Claude, then connect the service',
			paragraphs: [
				'Connecting Claude to Kody gives the agent access to your Kody account. You’ll also need to connect Google or Slack if your task uses those accounts, then build and test the workflow.',
				'Follow the client-specific guide for Claude Code or your other MCP host. Once connected, ask the agent to discover the service capabilities and test a small read operation before building a writing workflow.',
			],
		},
		{
			title: 'Keep the result of the conversation',
			paragraphs: [
				'Save repeated steps and task defaults in a documented package. Use memory only for facts that don’t fit in the package or another system. If you need the operation to run later, declare a job or use a workflow.',
				'You can start in Claude and continue from another connected agent using the same Kody account. This carries the saved resources, not the full conversation history or every client-specific feature.',
			],
		},
		{
			title: 'Start with one concrete task',
			paragraphs: [],
			steps: [
				'Pick a read-only operation, such as finding releases for a repository or inspecting a selected service resource.',
				'Connect the required account and run the operation. Check which account it used and what came back.',
				'Save useful code and its defaults in a package so another agent can run the same workflow.',
				'Connect a second agent to the same account and verify it can find the saved resource.',
			],
		},
		{
			title: 'Give Claude a workflow it can use again',
			paragraphs: [
				'Look up an email, turn a group of messages into a report, or build a tool around a task you repeat. Kody keeps the useful code so your agents can run it again.',
				'Start with Gmail, a custom tool, or a useful fact that isn’t stored elsewhere. Add more as you need them.',
			],
		},
	],
	prompt:
		'Help me connect Claude to my Kody account using the appropriate client guide. Then help me choose one read-only task to test. Explain which service connection it needs and what, if anything, should be saved as a package or memory.',
	sources: [
		{
			label: 'Connect your agent',
			href: '/docs/connect-your-agent',
		},
		{
			label: 'Packages, integrations, and MCP',
			href: '/docs/packages-integrations-mcp',
		},
		{
			label: 'Portability',
			href: '/docs/portability',
		},
	],
	related: ['gmail', 'sharedMemory', 'customTools'],
} satisfies AcquisitionPage
