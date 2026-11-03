import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const sharedMemory = {
	...acquisitionPageMeta.sharedMemory,
	lead: 'Put repeatable work in a package, with code and documented defaults your agents can reuse. Use shared memory for facts that don’t have a better home, like what you call a project or how you know someone.',
	flow: [
		'Save a fact in one agent',
		'Keep it in your Kody account',
		'Retrieve it in another agent',
	],
	sections: [
		{
			title: 'One project nickname, three agents',
			paragraphs: [
				'For example, you call your customer portal project “Maple.” Save that nickname if it isn’t already recorded in your project tools. Claude Code, Cursor, and Codex can retrieve the same fact when you mention Maple.',
				'The buttons on this page use example data. To try it yourself, connect two agents to the same Kody account, save a fact, and ask the other agent to find it.',
			],
		},
		{
			title: 'Share the facts, not every conversation',
			paragraphs: [
				'Use memory sparingly, for facts without a better home. If release summaries need source links and breaking changes first, build that into the release-summary package. Its code, typed inputs, and documented defaults carry the behavior whenever you run it.',
				'Kody finds a few relevant memories when your agent searches or runs code with task context. It doesn’t load everything, so a saved fact won’t necessarily show up in every response.',
			],
		},
		{
			title: 'Choose the right home for context',
			paragraphs: [],
			table: {
				headers: ['Information', 'Keep it in'],
				rows: [
					['A project nickname not recorded elsewhere', 'Kody memory'],
					[
						'Instructions for one repository or client',
						'That repository or client’s instructions',
					],
					['A job’s last processed item', 'Package storage'],
					['An API credential', 'A secret or integration'],
					[
						'Repeatable steps, output rules, and task defaults',
						'Package code and documentation',
					],
				],
			},
		},
		{
			title: 'Test that memory follows you',
			paragraphs: [],
			steps: [
				'Connect two agents to the same Kody account. Choose a harmless fact that isn’t already stored elsewhere.',
				'Ask the first agent to check existing memories, then save the fact. The agent checks what’s already saved before making a change.',
				'Ask the second agent to find the saved fact. Compare its answer with what was saved.',
				'Change the fact, verify the update from the other agent, then inspect or delete the memory from your account.',
			],
		},
		{
			title: 'Make repeatable behavior part of the package',
			paragraphs: [
				'A reply utility can quote the email thread automatically. A weather utility can have a documented default location. Put those choices in the package so the result doesn’t depend on an agent retrieving and following a memory.',
				'You can inspect and export Kody memories. Shared memory means sharing between your own connected agents, not automatically sharing private context with other people.',
			],
		},
	],
	prompt:
		'Help me test shared memory with a harmless project nickname that isn’t already recorded in my project tools. Ask me for the nickname and what it refers to, check existing Kody memories, then save or update the fact. Show me what was saved so I can ask another agent to retrieve it.',
	sources: [
		{
			label: 'Kody memory behavior and export',
			href: '/docs/memory',
		},
		{
			label: 'Where agent guidance lives',
			href: '/docs/agent-guidance',
		},
	],
	related: ['mcpGateway', 'claudeIntegrations', 'customTools'],
} satisfies AcquisitionPage
