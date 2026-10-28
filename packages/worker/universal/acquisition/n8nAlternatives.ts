import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const n8nAlternatives = {
	...acquisitionPageMeta.n8nAlternatives,
	lead: 'Describe the workflow you want and let your agent build it in Kody. Keep the working code, connect your accounts, and run it again from another agent or on a schedule.',
	flow: [
		'Describe a workflow',
		'Save a package',
		'Run it from any connected agent',
	],
	sections: [
		{
			title: 'Choose what you want to maintain',
			paragraphs: [
				'Pipedream’s October 2026 documentation says Workflows is in maintenance mode, with shutdown scheduled for March 31, 2027. Its Connect product is unaffected. If you’re building something new, choose a workflow tool that’s accepting new users.',
			],
			table: {
				headers: ['Approach', 'How it works', 'Why choose Kody'],
				rows: [
					[
						'Kody',
						'Your agent builds reusable packages with connected accounts, memory, and schedules',
						'Keep the code and context available across your connected agents',
					],
					[
						'n8n',
						'Visual workflows with code and AI steps',
						'Describe changes to your agent and keep the implementation in package code, rather than a workflow canvas',
					],
					[
						'Windmill',
						'Scripts and workflows for internal tools',
						'Keep personal context, connected accounts, and agent-built tools together in one account',
					],
					[
						'Pipedream Workflows',
						'Closed to new signups; shutdown scheduled for March 31, 2027',
						'Build new workflows as packages you can call from an agent or run on a schedule',
					],
				],
			},
		},
		{
			title: 'Build a release digest in Kody',
			paragraphs: [
				'Ask your agent to collect releases from selected GitHub repositories, group them by project, and prepare a Slack digest with links. Save the working code as a package, then add a schedule.',
			],
			steps: [
				'Start with a manual run that returns the digest without posting it. Verify the repository list, time window, and source links.',
				'Add durable state so a second run can identify releases already handled. Define how a failed Slack post affects that state.',
				'Change the request: exclude prereleases, add another repository, and change the destination. Review what needs editing.',
				'Test an expired connection and a repeated run before enabling a schedule. Check how much work it takes to recover, too.',
			],
		},
		{
			title: 'Where Kody fits',
			paragraphs: [
				'In Kody, your agent can explore a task, save the working code as a package, and call that package from another connected agent. Your connected accounts provide access to the services it needs, and the package keeps the code and any scheduled jobs together.',
				'So when a conversation produces something useful, you can keep it, review the code, and run it again without digging through the chat.',
			],
		},
		{
			title: 'Keep improving the same workflow',
			paragraphs: [
				'Need another source or a different report format? Ask your agent to update the package. The code stays available for you to review, and your other connected agents can use the updated workflow.',
				'A scheduled package runs the code you saved. It only needs a model when that code calls one, so a routine report can fetch and format its data without asking AI to rebuild the process each time.',
			],
		},
	],
	prompt:
		'Build a release-digest package in Kody for repositories I choose. Connect GitHub and Slack as needed. First return a preview with source links, without posting. Add stored progress and explain what happens if posting fails. Keep its schedule disabled until I approve a successful manual run.',
	sources: [
		{
			label: 'Kody package lifecycle',
			href: '/docs/package-lifecycle',
		},
		{
			label: 'Kody schedules and jobs',
			href: '/docs/triggers',
		},
		{
			label: 'n8n platform comparison',
			href: 'https://blog.n8n.io/n8n-alternatives/',
		},
		{
			label: 'Pipedream workflows',
			href: 'https://pipedream.com/docs/workflows',
		},
		{
			label: 'Windmill documentation',
			href: 'https://www.windmill.dev/docs/intro',
		},
	],
	related: ['scheduledWorkflows', 'customTools', 'automation'],
} satisfies AcquisitionPage
