import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const composioAlternatives = {
	...acquisitionPageMeta.composioAlternatives,
	lead: 'Kody brings your connected accounts, reusable tools, memory, and schedules together. Give your agents a place to keep the workflows they build for you.',
	flow: [
		'Your connected accounts',
		'Your saved workflows',
		'Your choice of agent',
	],
	sections: [
		{
			title: 'Choose by the job, not the integration count',
			paragraphs: [],
			table: {
				headers: ['Approach', 'What you build'],
				rows: [
					[
						'Kody',
						'Reusable packages with your connected accounts, memory, stored progress, and schedules, available across your agents',
					],
					[
						'Composio',
						'Agent integrations using its authentication and tool APIs, including customer connections inside your application',
					],
				],
			},
		},
		{
			title: 'What Kody adds to a personal workflow',
			paragraphs: [
				'Kody keeps the connected account, saved behavior, and personal context outside a single chat client. Your agent can explore a task, publish a package, and reuse it later from another client. A recurring job belongs to that package.',
				'For example, you can build a release digest that reads GitHub and prepares a Slack message. The account owns the logins, while the package owns the selection rules, formatting, and progress state.',
			],
		},
		{
			title: 'Keep the workflow with the connection',
			paragraphs: [
				'Kody gives your agent a place to save the code it builds, the progress it needs, and the documented defaults that shape the result.',
				'Use the saved package from another connected agent or give it a schedule. You can keep improving the same workflow as your needs change.',
			],
		},
		{
			title: 'Try the same task in both tools',
			paragraphs: [],
			steps: [
				'Pick one service and one read operation. Connect an account and confirm which identity is used.',
				'Add a second service and define the reusable operation. Identify which platform owns each part of the code and state.',
				'Disconnect an account and see what it takes to reconnect and run the task again.',
				'Repeat the operation from another agent or application context, according to your actual use case.',
				'Compare current pricing using expected calls and execution work. Include model calls only where your design uses them.',
			],
		},
	],
	prompt:
		'Help me evaluate Kody for my own agent workflows. Start with a read-only GitHub release lookup, save it as a package, and reuse it from two connected agents. Show where authentication, source code, and runtime state live.',
	sources: [
		{
			label: 'Composio documentation',
			href: 'https://docs.composio.dev/docs',
		},
		{
			label: 'Kody packages and connections',
			href: '/docs/packages-integrations-mcp',
		},
		{
			label: 'Kody pricing',
			href: '/pricing',
		},
		{
			label: 'Kody portability',
			href: '/docs/portability',
		},
	],
	related: ['n8nAlternatives', 'mcpGateway', 'customTools'],
} satisfies AcquisitionPage
