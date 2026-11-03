import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const scheduledWorkflows = {
	...acquisitionPageMeta.scheduledWorkflows,
	lead: 'Build your report once, then let Kody run it on a schedule. Your saved code, connected accounts, and progress stay together, and you can check the results without reopening the conversation.',
	flow: [
		'Build and test the operation',
		'Add a schedule and leave it off',
		'Enable it after a successful run',
	],
	sections: [
		{
			title: 'An agent run or a code run?',
			paragraphs: [],
			table: {
				headers: ['Task', 'Useful starting point'],
				rows: [
					[
						'Investigate changing information and choose the next action',
						'A scheduled agent routine',
					],
					[
						'Fetch known sources and produce a fixed-format report',
						'A saved package job',
					],
					['React to an incoming provider event', 'A webhook'],
					[
						'Run one operation later or beyond a request’s time budget',
						'A durable workflow',
					],
				],
			},
		},
		{
			title: 'Run the code you built',
			paragraphs: [
				'Kody runs your saved package on a schedule, with the same connected accounts and stored progress you used while building it. Your agent can update the package when the job changes.',
				'A package job runs code. It uses a model only if that code calls one. That distinction matters for repeatability and cost, especially for reports where fetching and formatting are already defined.',
			],
		},
		{
			title: 'Declare the schedule with the package',
			paragraphs: [
				'This manifest example declares a disabled daily job. The entry must exist in the package. Choose the timezone deliberately, test the entry, and only then enable it.',
			],
			code: '{\n  "kody": {\n    "jobs": {\n      "daily-digest": {\n        "entry": "./src/daily-digest.ts",\n        "schedule": { "type": "cron", "expression": "0 8 * * *" },\n        "timezone": "America/Denver",\n        "enabled": false\n      }\n    }\n  }\n}',
		},
		{
			title: 'Make a weekly report repeatable',
			paragraphs: [],
			steps: [
				'Define the sources, reporting window, output destination, and what to do when a source is unavailable.',
				'Write the report function and a small job file that calls it. Save its progress in package storage.',
				'Run it manually with a small window. Confirm both the output and any external writes.',
				'Publish with the schedule turned off, check the result, then turn it on.',
				'Inspect jobs and activity in your account. Distinguish a failed report from a successful run with no changes.',
			],
		},
		{
			title: 'Prefer the trigger that matches the work',
			paragraphs: [
				'A provider webhook can start work when an event happens. A recurring schedule is appropriate when you need a periodic summary or there is no useful event. Kody also supports subscriptions for events inside Kody.',
				'For a job that takes longer than a request, use the documented durable workflow pattern rather than assuming an interactive call can run indefinitely.',
			],
		},
	],
	prompt:
		'Build a weekly report package in Kody for sources I choose. Ask which dates to include and what the report should contain. Keep progress in package storage and show me a preview first. Add a package-owned schedule with my timezone, disabled until I verify the result.',
	sources: [
		{
			label: 'Jobs, workflows, and webhooks',
			href: '/docs/triggers',
		},
		{
			label: 'Kody pricing and limits',
			href: '/pricing',
		},
	],
	related: ['automation', 'slack', 'n8nAlternatives'],
} satisfies AcquisitionPage
