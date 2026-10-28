import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const slack = {
	...acquisitionPageMeta.slack,
	lead: 'Turn a repeated Slack task into saved code: collect the work, prepare a message with source links, and keep track of what you’ve already handled. Your connected agents can use the same package.',
	flow: [
		'Read selected source activity',
		'Build and review a digest',
		'Post to a chosen Slack channel',
	],
	sections: [
		{
			title: 'Native Slack MCP or a Kody package?',
			paragraphs: [
				'Slack offers an MCP server for agent access. Use direct access when you need the service’s tools in one client. A Kody integration plus a package is useful when you want saved selection rules, another service’s data, or a recurring job.',
				'Adding Slack as a remote MCP server and connecting Slack as an integration are separate choices. Follow the connection guide for the setup your workflow uses.',
			],
		},
		{
			title: 'Build a GitHub release digest',
			paragraphs: [],
			steps: [
				'Choose repositories and a Slack channel you can access. Connect the required accounts.',
				'Return a preview containing the repository, version, publication time, and release link. Exclude items according to explicit rules.',
				'After approval, send one test message to the chosen channel. Store progress only after the intended write succeeds.',
				'Run again against the same input. Check duplicate behavior, including what happens if sending succeeds but saving progress fails.',
				'Enable a package-owned schedule after the manual test. Check run history when a connection or service fails.',
			],
		},
		{
			title: 'Decide what belongs in a message',
			paragraphs: [
				'A digest should make it easy to act: link each item to its source, use a clear time window, and omit unchanged items. If you want generated commentary, make the model call explicit and preserve the underlying source links.',
				'Don’t post every intermediate result. Return an empty result when there is no new work, and make errors distinguishable from an empty digest.',
			],
		},
		{
			title: 'Keep state with the workflow',
			paragraphs: [
				'The package should own its checkpoint and duplicate-handling rules. A remembered personal preference can shape the message style, but it shouldn’t be the database of already-posted releases.',
				'The agent needs access to the source and destination you choose. Connecting Kody doesn’t expand what the Slack account is allowed to see.',
			],
		},
	],
	prompt:
		'Create a Kody package for a GitHub release digest in Slack. Ask me for repositories and a channel. Start with a preview, include release links, store progress with the package, and explain duplicate handling around failed writes. Don’t post or enable a schedule until I approve the preview.',
	sources: [
		{
			label: 'Connect Slack',
			href: '/docs/slack',
		},
		{
			label: 'Package and integration example',
			href: '/docs/packages-integrations-mcp',
		},
		{
			label: 'Jobs and workflows',
			href: '/docs/triggers',
		},
		{
			label: 'Slack MCP guide',
			href: 'https://slack.com/help/articles/48855576908307-Guide-to-the-Slack-MCP-server',
		},
	],
	related: ['scheduledWorkflows', 'gmail', 'customTools'],
} satisfies AcquisitionPage
