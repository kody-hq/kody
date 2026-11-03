import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const automation = {
	...acquisitionPageMeta.automation,
	lead: 'Work through a task with your agent, then save the code that works. Kody keeps it with your connected accounts and memory, and you can put repeatable work on a schedule.',
	flow: [
		'Explore with an agent',
		'Save the working code',
		'Run it when the work needs doing',
	],
	sections: [
		{
			title: 'Where code and AI fit in a workflow',
			paragraphs: [
				'These examples use sample data, nothing runs in your accounts. A release digest can collect GitHub releases with code, ask a model to explain their impact on a project, then format a preview. Keep processed release IDs in package storage and check source links before posting.',
				'Inbox triage can collect matching Gmail messages, ask a model to draft a response using the thread and the package’s reply settings, and save a draft for review. Keep thread and draft IDs so a repeated run doesn’t create another draft. You choose whether to send.',
				'A weekly report can fetch data and calculate changes with code, ask a model to investigate notable differences, and save the report and its checkpoint. Keep the reporting window and previous snapshot. Verify the explanation against source data before acting.',
			],
		},
		{
			title: 'Choose how the work should run',
			paragraphs: [],
			table: {
				headers: ['Approach', 'Use it when', 'What you maintain'],
				rows: [
					[
						'Visual workflow',
						'A graph is the clearest way to explain and edit the process',
						'Nodes, connections, and execution rules',
					],
					[
						'Agent routine',
						'Each run needs investigation or judgment',
						'Instructions, tools, and what needs your approval',
					],
					[
						'Saved code',
						'Inputs and behavior are clear enough to implement',
						'A package that says what it accepts and returns',
					],
					[
						'A combination',
						'Only part of the process needs reasoning',
						'Code that calls a model for the step that needs it',
					],
				],
			},
		},
		{
			title: 'Use AI for the parts that need judgment',
			paragraphs: [
				'You don’t need a model to fetch releases and format links. Figuring out which changes affect your project is a better use for it. Keep those steps separate so you can check the code and the AI’s answer.',
				'A Kody package can use connected services and saved state. A job or webhook can start it without a chat session. If your code calls a model, you’ll need to account for that usage and cost, too.',
			],
		},
		{
			title: 'Build the smallest useful workflow',
			paragraphs: [],
			steps: [
				'Define one output a person can verify, such as a digest with source links or a draft reply.',
				'Connect only the accounts required for that output and start with a manual preview.',
				'Save the working operation as a package. Document input, output, empty results, and failures.',
				'Decide what should happen when it runs again, especially if it posts messages or changes data.',
				'Run it when you ask, on a schedule, or when a webhook arrives, whichever fits the task.',
			],
		},
		{
			title: 'State belongs with the thing that uses it',
			paragraphs: [
				'Put repeatable steps and task defaults in package code and documentation. Use memory sparingly for facts without a better home. Use package storage for checkpoints and job state. Use integrations and secrets for authentication. Keeping those separate makes the workflow easier to inspect and change.',
			],
		},
		{
			title: 'Choose a first project',
			paragraphs: [
				'A GitHub-to-Slack digest lets you try two services together and check for duplicate posts. A Gmail drafts workflow lets you review replies before sending. Or save a preference and see whether another agent can find it.',
				'Start with the project you will actually use. Measure whether it finishes the job correctly before expanding it into a larger automation. Compare runtime limits and pricing against expected usage, not a hypothetical maximum workload.',
			],
		},
	],
	prompt:
		'Help me turn one repeated task into a Kody package. First work out what it needs, what it should produce, which accounts it uses, and what needs my approval. Use code for predictable steps and explain where a model would help. Show me a preview, then help me test failures and repeated runs before putting it on a schedule.',
	sources: [
		{
			label: 'How Kody works',
			href: '/docs/how-kody-works',
		},
		{
			label: 'Search and execute',
			href: '/docs/search-and-execute',
		},
		{
			label: 'Jobs and workflows',
			href: '/docs/triggers',
		},
		{
			label: 'Pricing and limits',
			href: '/pricing',
		},
	],
	related: [
		'n8nAlternatives',
		'slack',
		'gmail',
		'scheduledWorkflows',
		'sharedMemory',
		'mcpGateway',
		'customTools',
		'composioAlternatives',
		'claudeIntegrations',
	],
} satisfies AcquisitionPage
