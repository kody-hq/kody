import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const mcpGateway = {
	...acquisitionPageMeta.mcpGateway,
	lead: 'An MCP gateway sits between agents and tools. Kody gives your agents a shared place to discover tools, use connected accounts, and keep the code and memory that should carry between conversations.',
	flow: [
		'Claude, Cursor, or Codex',
		'Kody search and execute',
		'Connected services and saved packages',
	],
	sections: [
		{
			title: 'Direct connection, gateway, or Kody?',
			paragraphs: [],
			table: {
				headers: ['Choose', 'When it fits', 'What it gives you'],
				rows: [
					[
						'Direct MCP',
						'One agent needs one service',
						'The service’s tools through that agent’s connection',
					],
					[
						'MCP gateway',
						'You want one connection point for several tools',
						'Tool routing and the policies offered by that gateway',
					],
					[
						'Kody',
						'Your agents need the same saved tools and context',
						'Tools your agents can find and run, saved memory, and packages',
					],
				],
			},
		},
		{
			title: 'A connection is only the beginning',
			paragraphs: [
				'Connecting an agent to a tool gives it access to an operation. It doesn’t, by itself, save the workflow you developed around that operation. Kody keeps that workflow as code in a package, with its own exports, storage, and optional jobs.',
				'Kody can also connect to an existing remote MCP server. An integration keeps the credentials for a service, while a package keeps your code. Use the setup your service and task need.',
			],
		},
		{
			title: 'Try the same operation from two agents',
			paragraphs: [],
			steps: [
				'Connect the first agent to your Kody account using the connection guide.',
				'Ask it to discover the relevant tools and build a small read-only operation, such as listing releases for a repository.',
				'Save the working operation as a package with a clear description of its input and output.',
				'Connect a second agent to the same account. Ask it to find and run the saved operation rather than recreate it.',
			],
		},
		{
			title: 'How discovery works',
			paragraphs: [
				'Your agent uses Kody’s search and execute tools to find what it needs and combine those tools in code. Save the working code as a package, and it can use it again the next time you ask.',
			],
		},
		{
			title: 'Check your gateway requirements',
			paragraphs: [
				'If you’re choosing a gateway for a company, check its access rules, team controls, audit exports, and where it can run. Sharing tools between your own agents doesn’t cover all of those needs.',
				'Kody’s package runtime is also different from hosting an arbitrary MCP server process. Use the remote-server connection guide when connecting an existing server.',
			],
		},
	],
	prompt:
		'Help me connect this agent to Kody. Build a read-only GitHub release lookup, save it as a package, and tell me how to find and run the same package from another agent connected to my account.',
	sources: [
		{
			label: 'Connect an agent',
			href: '/docs/connect-your-agent',
		},
		{
			label: 'Search and execute',
			href: '/docs/search-and-execute',
		},
		{
			label: 'Packages, integrations, and MCP',
			href: '/docs/packages-integrations-mcp',
		},
		{
			label: 'Control access to a remote MCP server',
			href: '/docs/locked-mcp-server',
		},
	],
	related: ['claudeIntegrations', 'customTools', 'sharedMemory'],
} satisfies AcquisitionPage
