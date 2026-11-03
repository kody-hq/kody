import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const customTools = {
	...acquisitionPageMeta.customTools,
	lead: 'A useful Claude Code session should leave you with something you can run again. Save the working operation as a Kody package, then find and call it from any agent connected to the same account.',
	flow: [
		'Explore the task',
		'Publish a callable package',
		'Reuse and revise it',
	],
	sections: [
		{
			title: 'Choose a small operation with a clear result',
			paragraphs: [
				'Start with a release lookup, a report formatter, or a read-only account check. Decide its input, the output a caller should expect, and what should happen when a service is unavailable.',
				'An instruction file tells an agent how to work. A package contains code the agent can execute. Keep both where they help: instructions for choosing the tool, code for the operation that should be repeatable.',
			],
		},
		{
			title: 'From a conversation to a saved tool',
			paragraphs: [],
			steps: [
				'Connect Claude Code to Kody and ask it to load the package-authoring guide.',
				'Explore the relevant service through search and execute. Prove the smallest read-only operation first.',
				'Save the code in a package with an exported function and a description of what it accepts and returns. Publish the package so your agents can use it.',
				'Find and run the package from a fresh conversation. Then repeat from a second connected agent.',
				'Make a small change, review it, and publish it. If the package is locked, use the owner approval flow.',
			],
		},
		{
			title: 'Define behavior that survives a second run',
			paragraphs: [
				'For a release lookup, decide how to handle an empty repository list, pagination, missing access, and prereleases. For a writing operation, define duplicate handling before you add a schedule.',
				'Keep credentials in account integrations or secrets, not in source code. Keep track of the last completed step in package storage. Give callers enough structured output to distinguish an empty result from a failed request.',
			],
		},
		{
			title: 'Reuse before adding a schedule',
			paragraphs: [
				'Get the tool working when you ask for it first. Once the operation is stable, a package-owned job can run a wrapper on a schedule. The same saved behavior can serve both the interactive tool and the recurring task.',
				'Kody runs within its documented runtime and usage limits. A saved package isn’t a promise that every local program, binary, or long-running server will work unchanged.',
			],
		},
	],
	prompt:
		'Load the Kody package-authoring guide. Build a read-only release lookup for a list of GitHub repositories. Return repository, version, release URL, and publication time. Handle missing access separately from no releases. Save and publish it as a reusable package, then show me how another connected agent can find it.',
	sources: [
		{
			label: 'Package authoring',
			href: '/docs/package-authoring',
		},
		{
			label: 'Package lifecycle',
			href: '/docs/package-lifecycle',
		},
		{
			label: 'Connect your agent',
			href: '/docs/connect-your-agent',
		},
		{
			label: 'Search and execute',
			href: '/docs/search-and-execute',
		},
	],
	related: ['scheduledWorkflows', 'mcpGateway', 'n8nAlternatives'],
} satisfies AcquisitionPage
