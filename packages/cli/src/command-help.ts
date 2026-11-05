import { readPackageVersion } from './package-info.js'

export type CommandHelpNode = {
	name: string
	summary: string
	usage: Array<string>
	flags?: Array<[flag: string, description: string]>
	notes?: Array<string>
	subcommands?: Array<CommandHelpNode>
}

const jsonFlag: [string, string] = ['--json', 'Print JSON for agents']
const orgFlag: [string, string] = [
	'--org <slug>',
	'Run as this org for one call (else KODY_ORG, then the active org)',
]
const mcpUrlFlag: [string, string] = [
	'--mcp-url <url>',
	'Kody MCP URL (default from KODY_MCP_URL)',
]
const apiUrlFlag: [string, string] = [
	'--api-url <url>',
	'Kody API URL (default from KODY_API_URL)',
]
const tokenFlag: [string, string] = [
	'--token <token>',
	'Scoped API token (prefer the KODY_API_TOKEN env var)',
]
const targetFlag: [string, string] = [
	'--target prod|mock',
	'Where API hops go: real Kody or the built-in local mock',
]
const ecContextFlag: [string, string] = [
	'--context <ec id>',
	'Execution context on this machine (default: the only one registered)',
]
const devTargetFlag: [string, string] = [
	'--target prod|mock',
	'Where API hops go (default mock for kody dev)',
]
const dryRunFlag: [string, string] = [
	'--dry-run',
	'Print the module path and params without invoking',
]

export const commandHelpTree: Array<CommandHelpNode> = [
	{
		name: 'login',
		summary: 'Sign in to Kody in the browser (or with a device code)',
		usage: [
			'kody login [--mcp-url <url>] [--org <slug>] [--no-browser | --device]',
		],
		flags: [
			[
				'--org <slug>',
				'Bind the login to this org (adds or replaces that org login)',
			],
			['--no-browser', 'Print the sign-in URL instead of opening a browser'],
			['--device', 'Sign in with a device code (headless machines)'],
			mcpUrlFlag,
		],
	},
	{
		name: 'logout',
		summary: 'Remove the active org login (or one org with --org)',
		usage: ['kody logout [--org <slug>] [--mcp-url <url>] [--api-url <url>]'],
		flags: [
			['--org <slug>', 'Remove only this org login'],
			mcpUrlFlag,
			apiUrlFlag,
		],
	},
	{
		name: 'org',
		summary: 'List logged-in orgs or switch the active org',
		usage: ['kody org <command> [flags]'],
		subcommands: [
			{
				name: 'list',
				summary: 'Show logged-in orgs and mark the active one',
				usage: ['kody org list [--json] [--mcp-url <url>]'],
				flags: [jsonFlag, mcpUrlFlag],
			},
			{
				name: 'use',
				summary:
					'Switch the active org (interactive chooser without a slug on a TTY)',
				usage: ['kody org use [<slug>] [--mcp-url <url>]'],
				flags: [mcpUrlFlag],
			},
		],
	},
	{
		name: 'status',
		summary: 'Show login, token, and server status',
		usage: ['kody status [--mcp-url <url>] [--api-url <url>]'],
		flags: [mcpUrlFlag, apiUrlFlag],
	},
	{
		name: 'auth',
		summary: 'Store scoped API tokens and set up Git credentials',
		usage: ['kody auth <command> [flags]'],
		subcommands: [
			{
				name: 'bootstrap',
				summary:
					'Redeem a kody_bc_… code (or mint one with --scopes) and store the token',
				usage: [
					'kody auth bootstrap (--code <kody_bc_…> | --scopes <list>) (--lifetime short|long | --idle-ttl-seconds <n> --max-lifetime-seconds <n>)',
					'                    [--token <token>] [--mcp-url <url>] [--api-url <url>]',
				],
				flags: [
					[
						'--code <kody_bc_…>',
						'One-shot bootstrap code from cliCredentialBootstrap',
					],
					[
						'--scopes <list>',
						'Mint a code with exactly these scopes (replaces the defaults)',
					],
					[
						'--lifetime short|long',
						'short = 1h idle / 24h max; long = 14d idle / 3mo max',
					],
					[
						'--idle-ttl-seconds <n>',
						'Custom idle lifetime (with --max-lifetime-seconds)',
					],
					[
						'--max-lifetime-seconds <n>',
						'Custom max lifetime (with --idle-ttl-seconds)',
					],
					tokenFlag,
					mcpUrlFlag,
					apiUrlFlag,
				],
			},
			{
				name: 'setup-git',
				summary:
					'Install a Git credential helper for https://kody.codes/@owner/name.git',
				usage: [
					'kody auth setup-git [--lifetime long|short] [--scopes <list>] [--token <token>] [--mcp-url <url>] [--api-url <url>]',
				],
				flags: [
					[
						'--lifetime long|short',
						'Lifetime of the minted token (default long)',
					],
					[
						'--scopes <list>',
						'Extra scopes beyond package:read and package:write',
					],
					tokenFlag,
					mcpUrlFlag,
					apiUrlFlag,
				],
			},
			{
				name: 'remove-git',
				summary: 'Remove the Git credential helper and revoke its stored token',
				usage: ['kody auth remove-git [--mcp-url <url>] [--api-url <url>]'],
				flags: [mcpUrlFlag, apiUrlFlag],
			},
		],
	},
	{
		name: 'git-credential',
		summary: 'Git credential helper invoked by git after `kody auth setup-git`',
		usage: ['kody git-credential <get|store|erase>'],
		notes: [
			'Not meant for interactive use; git calls it with get, store, or erase.',
		],
	},
	{
		name: 'whoami',
		summary: 'Show who the CLI acts as and which credential it picked',
		usage: [
			'kody whoami [--org <slug>] [--target prod|mock] [--mcp-url <url>] [--token <token>] [--api-url <url>] [--json]',
		],
		flags: [orgFlag, targetFlag, mcpUrlFlag, tokenFlag, apiUrlFlag, jsonFlag],
	},
	{
		name: 'search',
		summary: 'Search capabilities, packages, and docs',
		usage: [
			'kody search [query] [--org <slug>] [--entity <ref>] [--domain <id>] [--limit <n>] [--target prod|mock] [--token <token>] [--api-url <url>] [--json]',
		],
		flags: [
			orgFlag,
			['--entity <ref>', 'Look up one entity by ref'],
			['--domain <id>', 'Limit results to one capability domain'],
			['--limit <n>', 'Maximum results'],
			targetFlag,
			tokenFlag,
			apiUrlFlag,
			jsonFlag,
		],
	},
	{
		name: 'api',
		summary: 'Call one Open API operation by operationId',
		usage: [
			'kody api <operationId> [--org <slug>] [--params <json>] [--token <token>] [--api-url <url>] [--json]',
		],
		flags: [
			orgFlag,
			['--params <json>', 'Flat JSON params (same shape as the MCP api tool)'],
			tokenFlag,
			apiUrlFlag,
			jsonFlag,
		],
		notes: ["Example: kody api usageGet --params '{}'"],
	},
	{
		name: 'package',
		summary: 'Publish packages and manage who can use them',
		usage: ['kody package <command> [flags]'],
		subcommands: [
			{
				name: 'publish',
				summary:
					'Publish the package in this git repo (packagePublishExternalPush)',
				usage: [
					'kody package publish [<@owner/leaf|package_id>] [--build local|context] [--context <name|cloud>] [--org <slug>] [--params <json>] [--token <token>] [--api-url <url>] [--json]',
				],
				flags: [
					[
						'--build local|context',
						'Build on this machine or on an execution context',
					],
					[
						'--context <name|cloud>',
						'Execution context that builds it (with --build context)',
					],
					orgFlag,
					['--params <json>', 'Extra publish fields, e.g. allow_force'],
					tokenFlag,
					apiUrlFlag,
					jsonFlag,
				],
			},
			{
				name: 'collaborators',
				summary: 'List the teams and people who can use a package',
				usage: [
					'kody package collaborators <package> [--org <slug>] [--json] [--token <token>] [--api-url <url>]',
				],
				flags: [orgFlag, jsonFlag, tokenFlag, apiUrlFlag],
			},
			{
				name: 'grant',
				summary: 'Share a package with a team or user, or change their preset',
				usage: [
					'kody package grant <package> (--team <slug> | --user <username>) [--preset read|use|contribute|manage] [--allow-changes-despite-unmappable-credentials | --disallow-changes-despite-unmappable-credentials] [--org <slug>] [--json]',
				],
				flags: [
					['--team <slug>', 'Team to share with'],
					[
						'--user <username>',
						'Person to share with (outside the org adds an outside collaborator)',
					],
					[
						'--preset read|use|contribute|manage',
						'What they can do (default use)',
					],
					[
						'--allow-changes-despite-unmappable-credentials',
						'Let them change it even if credentials cannot be mapped',
					],
					[
						'--disallow-changes-despite-unmappable-credentials',
						'Turn that back off',
					],
					orgFlag,
					jsonFlag,
				],
			},
			{
				name: 'revoke',
				summary: 'Remove a team, user, or grant from a package',
				usage: [
					'kody package revoke <package> (--team <slug> | --user <username> | --grant <grant_id>) [--org <slug>] [--json]',
				],
				flags: [
					['--team <slug>', 'Team to remove'],
					['--user <username>', 'Person to remove'],
					['--grant <grant_id>', 'Grant to remove'],
					orgFlag,
					jsonFlag,
				],
			},
		],
	},
	{
		name: 'execute',
		summary:
			'Run a module on Kody cloud, an execution context, or this machine',
		usage: [
			'kody execute [--org <slug>] [--invoke <ref> | --code <esm> | --file <path>] [--params <json>] [--conversation-id <id>] [--json]',
			'             [--credential <key=name>]… [--context <id|name>] [--fallback chain] [--requires fs,lan] [--chain <a,b,cloud>] [--target prod|mock] [--token <token>] [--api-url <url>] [--local] [--allow-private-network]',
		],
		flags: [
			orgFlag,
			[
				'--invoke <ref>',
				'Run a package export (kody:@scope/pkg/export, or ./export in a package dir)',
			],
			['--code <esm>', 'Run this module source'],
			['--file <path>', 'Bundle and run this file'],
			['--params <json>', 'Params passed to the module'],
			['--conversation-id <id>', 'Conversation to attach the run to'],
			[
				'--credential <key=name>',
				'Pick the credential for credential(key) calls (repeatable)',
			],
			['--context <id|name>', 'Run on one execution context'],
			[
				'--fallback chain',
				'With --context, fall back to the chain when it cannot run',
			],
			[
				'--requires fs,lan',
				'Skip targets without local files or the local network',
			],
			['--chain <a,b,cloud>', "This run's own ordered chain"],
			targetFlag,
			tokenFlag,
			apiUrlFlag,
			['--local', 'Run in local workerd on this machine (Node.js 22+)'],
			[
				'--allow-private-network',
				'Let --local code fetch private and local addresses',
			],
			[
				'--reset-storage',
				'With --target mock, wipe mock scratch storage first',
			],
			jsonFlag,
		],
	},
	{
		name: 'dev',
		summary: 'Serve and test an unpublished package locally',
		usage: ['kody dev [serve] [flags]', 'kody dev <command> [flags]'],
		notes: ['With no command, `kody dev` runs `kody dev serve`.'],
		subcommands: [
			{
				name: 'serve',
				summary:
					'Serve kody.app.entry on localhost with hot reload (the default)',
				usage: [
					'kody dev serve [--org <slug>] [--target prod|mock] [--reset-storage] [--passthrough <host,…>] [--port <n>] [--app-base-path <path>] [--allow-private-network] [--no-live-reload] [--json] [--ready-file <path>]',
				],
				flags: [
					orgFlag,
					devTargetFlag,
					[
						'--reset-storage',
						'With --target mock, wipe mock scratch storage first',
					],
					['--port <n>', 'Exact port (0 = any; default is stable per package)'],
					[
						'--app-base-path <path>',
						'Public mount path stripped before workerd',
					],
					[
						'--allow-private-network',
						'Let app code fetch private and local addresses',
					],
					[
						'--no-live-reload',
						'Turn off HTML live reload and the error overlay',
					],
					[
						'--passthrough <host,…>',
						'With .kody/mocks.ts on mock, let these hosts use the real network',
					],
					[
						'--json',
						'Stream NDJSON events (ready, rebuild_ok, build_error, …)',
					],
					[
						'--ready-file <path>',
						'Write { url, port, basePath, pid } once ready',
					],
				],
			},
			{
				name: 'fetch',
				summary:
					'Request a path from the running dev server (or a one-shot server)',
				usage: [
					'kody dev fetch <path> [--method <verb>] [--body <file>] [--target prod|mock] [--json] [--no-attach]',
				],
				flags: [
					['--method <verb>', 'HTTP method (default GET)'],
					['--body <file>', 'Request body file'],
					devTargetFlag,
					jsonFlag,
					[
						'--no-attach',
						'Boot a one-shot server instead of using a running kody dev',
					],
				],
			},
			{
				name: 'job',
				summary: 'Run a job once (never schedules locally)',
				usage: [
					'kody dev job <name> [--target prod|mock] [--dry-run] [--json]',
				],
				flags: [devTargetFlag, dryRunFlag, jsonFlag],
			},
			{
				name: 'webhook',
				summary: 'Deliver a webhook payload to the package',
				usage: [
					'kody dev webhook <name> --body <file.json> [--target prod|mock] [--dry-run] [--json]',
				],
				flags: [
					['--body <file.json>', 'Webhook payload'],
					devTargetFlag,
					dryRunFlag,
					jsonFlag,
				],
			},
			{
				name: 'emit',
				summary: "Emit an event to the package's subscriptions",
				usage: [
					'kody dev emit <event> --body <event.json> [--target prod|mock] [--dry-run] [--json]',
				],
				flags: [
					['--body <event.json>', 'Event payload'],
					devTargetFlag,
					dryRunFlag,
					jsonFlag,
				],
			},
			{
				name: 'check',
				summary:
					'Bundle and run the publish checks without running the package',
				usage: [
					'kody dev check [--target prod|mock] [--offline] [--debug] [--json]',
				],
				flags: [
					devTargetFlag,
					['--offline', 'Skip the server publish checks'],
					['--debug', 'Print the publish checks call to stderr'],
					jsonFlag,
				],
			},
		],
	},
	{
		name: 'install',
		summary: 'Add Kody as an MCP server to local agent clients',
		usage: [
			'kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]',
		],
		flags: [
			mcpUrlFlag,
			['--clients <ids>', 'Comma-separated client ids'],
			['--yes', 'Skip the confirmation prompt'],
			['--project', 'Write project-level config instead of user-level'],
			jsonFlag,
		],
	},
	{
		name: 'skill',
		summary: 'Install the Kody agent skill',
		usage: ['kody skill <command> [flags]'],
		subcommands: [
			{
				name: 'install',
				summary: 'Install the Kody skill for local agents',
				usage: ['kody skill install [--project]'],
				flags: [
					['--project', 'Install into this project instead of your user dir'],
				],
			},
		],
	},
	{
		name: 'version',
		summary: 'Print the CLI version',
		usage: ['kody version'],
	},
	{
		name: 'context',
		summary:
			'Register and manage execution contexts (machines that run your code)',
		usage: ['kody context <command> [flags]'],
		notes: [
			'Execution contexts are an experiment. Turn it on at https://kody.codes/account/experiments.',
		],
		subcommands: [
			{
				name: 'register',
				summary: 'Register this machine as an execution context',
				usage: ['kody context register --name <name> [--org <slug>] [--json]'],
				flags: [['--name <name>', 'Name for this machine'], orgFlag, jsonFlag],
			},
			{
				name: 'list',
				summary: 'List your execution contexts',
				usage: ['kody context list [--org <slug>] [--json]'],
				flags: [orgFlag, jsonFlag],
			},
			{
				name: 'revoke',
				summary:
					'Revoke a context: kill its key, disconnect it, cancel its runs',
				usage: ['kody context revoke <name|ec id> [--org <slug>] [--json]'],
				flags: [orgFlag, jsonFlag],
			},
			{
				name: 'delete',
				summary: 'Permanently delete a revoked context',
				usage: ['kody context delete <name|ec id> [--org <slug>] [--json]'],
				flags: [orgFlag, jsonFlag],
			},
			{
				name: 'cancel-run',
				summary: 'Cancel one run on a context',
				usage: [
					'kody context cancel-run <name|ec id> <run id> [--org <slug>] [--json]',
				],
				flags: [orgFlag, jsonFlag],
			},
			{
				name: 'policy',
				summary:
					'Show or change which host folders runs on this machine can use',
				usage: ['kody context policy [<command>] [flags]'],
				notes: ['With no command, shows the policy.'],
				subcommands: [
					{
						name: 'show',
						summary: 'Show the host folder policy',
						usage: ['kody context policy show [--json]'],
						flags: [jsonFlag],
					},
					{
						name: 'allow',
						summary: 'Allow runs to use a host folder',
						usage: ['kody context policy allow <path> [--mode ro|rw] [--json]'],
						flags: [
							['--mode ro|rw', 'Read-only or read-write (default ro)'],
							jsonFlag,
						],
					},
					{
						name: 'remove',
						summary: 'Remove a host folder from the policy',
						usage: ['kody context policy remove <path> [--json]'],
						flags: [jsonFlag],
					},
				],
			},
			{
				name: 'commands',
				summary: 'Turn host commands (your own runs on this machine) on or off',
				usage: [
					'kody context commands [<command>] [--context <name>] [--json]',
				],
				flags: [['--context <name>', 'Context to check or turn off'], jsonFlag],
				notes: ['With no command, shows the status.'],
				subcommands: [
					{
						name: 'status',
						summary: 'Show whether host commands are on',
						usage: ['kody context commands status [--context <name>] [--json]'],
						flags: [['--context <name>', 'Context to check'], jsonFlag],
					},
					{
						name: 'on',
						summary: 'Turn host commands on (only on this machine)',
						usage: ['kody context commands on [--json]'],
						flags: [jsonFlag],
					},
					{
						name: 'off',
						summary: 'Turn host commands off',
						usage: ['kody context commands off [--context <name>] [--json]'],
						flags: [
							[
								'--context <name>',
								'Context to turn off (works from any machine)',
							],
							jsonFlag,
						],
					},
				],
			},
		],
	},
	{
		name: 'chain',
		summary: 'Show or change your default execution chain',
		usage: ['kody chain [<command>] [--org <slug>] [--json]'],
		flags: [orgFlag, jsonFlag],
		notes: ['With no command, shows the chain. Offline contexts are skipped.'],
		subcommands: [
			{
				name: 'show',
				summary: 'Show your default chain',
				usage: ['kody chain show [--org <slug>] [--json]'],
				flags: [orgFlag, jsonFlag],
			},
			{
				name: 'add',
				summary: 'Add a context to your chain (before cloud)',
				usage: ['kody chain add <name> [--org <slug>] [--json]'],
				flags: [orgFlag, jsonFlag],
			},
			{
				name: 'remove',
				summary: 'Remove a context from your chain',
				usage: ['kody chain remove <name> [--org <slug>] [--json]'],
				flags: [orgFlag, jsonFlag],
			},
		],
	},
	{
		name: 'connect',
		summary:
			'Register this machine and install the daemon as a background service',
		usage: [
			'kody connect --name <name> [--org <slug>] [--no-install] [--key-storage keyring|file] [--yes]',
		],
		flags: [
			['--name <name>', 'Name for this machine'],
			orgFlag,
			['--no-install', 'Register only; do not install the background service'],
			['--key-storage keyring|file', 'Where the service reads the machine key'],
			['--yes', 'Skip confirmation prompts'],
		],
	},
	{
		name: 'daemon',
		summary:
			'Run the execution-context daemon, or manage its background service',
		usage: [
			'kody daemon [--context <ec id>] [--max-concurrent <n>]',
			'kody daemon <command> [flags]',
		],
		flags: [
			ecContextFlag,
			['--max-concurrent <n>', 'Runs at once (foreground daemon)'],
		],
		notes: [
			'With no command, runs the daemon in the foreground until Ctrl-C.',
			'The service is systemd --user on Linux (and WSL with systemd), a LaunchAgent on macOS, and a Task Scheduler logon task on Windows.',
		],
		subcommands: [
			{
				name: 'install',
				summary: 'Install the daemon as a per-user background service',
				usage: [
					'kody daemon install [--context <ec id>] [--max-concurrent <n>] [--key-storage keyring|file] [--yes]',
				],
				flags: [
					ecContextFlag,
					['--max-concurrent <n>', 'Runs at once'],
					[
						'--key-storage keyring|file',
						'Where the service reads the machine key',
					],
					['--yes', 'Skip confirmation prompts'],
				],
			},
			{
				name: 'status',
				summary: 'Show the service state and each problem with its fix',
				usage: ['kody daemon status [--context <ec id>] [--json]'],
				flags: [ecContextFlag, jsonFlag],
			},
			{
				name: 'logs',
				summary: 'Print the daemon log',
				usage: [
					'kody daemon logs [--context <ec id>] [--lines <n>] [--follow]',
				],
				flags: [
					ecContextFlag,
					['--lines <n>', 'Lines from the end (default 100)'],
					['--follow', 'Keep printing new lines'],
				],
			},
			{
				name: 'restart',
				summary: 'Restart the service after runs in flight finish',
				usage: ['kody daemon restart [--context <ec id>]'],
				flags: [ecContextFlag],
			},
			{
				name: 'start',
				summary: 'Start the stopped service',
				usage: ['kody daemon start [--context <ec id>]'],
				flags: [ecContextFlag],
			},
			{
				name: 'stop',
				summary:
					'Stop the service after runs in flight finish, without unregistering',
				usage: ['kody daemon stop [--context <ec id>]'],
				flags: [ecContextFlag],
				notes: [
					'The context shows offline, so chains skip it. It stays stopped until `kody daemon start` or the next login or boot.',
				],
			},
			{
				name: 'uninstall',
				summary: 'Remove the background service',
				usage: [
					'kody daemon uninstall [--context <ec id>] [--unregister | --no-unregister]',
				],
				flags: [
					ecContextFlag,
					['--unregister', 'Also revoke the execution context'],
					['--no-unregister', 'Keep the execution context registered'],
				],
			},
			{
				name: 'auto-update',
				summary: 'Show or change daemon auto-update on this machine',
				usage: ['kody daemon auto-update [<command>] [--json]'],
				flags: [jsonFlag],
				notes: ['With no command, shows the status.'],
				subcommands: [
					{
						name: 'status',
						summary: 'Show whether auto-update is on',
						usage: ['kody daemon auto-update status [--json]'],
						flags: [jsonFlag],
					},
					{
						name: 'on',
						summary: 'Turn auto-update on',
						usage: ['kody daemon auto-update on [--json]'],
						flags: [jsonFlag],
					},
					{
						name: 'off',
						summary: 'Turn auto-update off',
						usage: ['kody daemon auto-update off [--json]'],
						flags: [jsonFlag],
					},
				],
			},
		],
	},
	{
		name: 'update',
		summary:
			'Install the latest CLI and restart daemon services after runs finish',
		usage: ['kody update'],
	},
	{
		name: 'help',
		summary: 'Show help for kody or one command',
		usage: ['kody help [<command> …]'],
	},
]

/**
 * The deepest command node named by the leading positionals, so
 * `kody daemon stop extra --help` still finds `daemon stop`.
 */
export function findCommandHelp(
	path: Array<string>,
): { node: CommandHelpNode; path: Array<string> } | null {
	let nodes = commandHelpTree
	let deepest: CommandHelpNode | null = null
	const matched: Array<string> = []
	for (const segment of path) {
		const node = nodes.find((candidate) => candidate.name === segment)
		if (!node) break
		deepest = node
		matched.push(segment)
		nodes = node.subcommands ?? []
	}
	return deepest ? { node: deepest, path: matched } : null
}

function formatRows(rows: Array<[string, string]>): string {
	const width = Math.min(Math.max(...rows.map(([left]) => left.length)) + 2, 34)
	return rows
		.map(([left, right]) =>
			left.length + 2 > width
				? `  ${left}\n  ${' '.repeat(width)}${right}`
				: `  ${left.padEnd(width)}${right}`,
		)
		.join('\n')
}

export function buildCommandHelp(path: Array<string>): string | null {
	const found = findCommandHelp(path)
	if (!found) return null
	const { node } = found
	const full = `kody ${found.path.join(' ')}`
	const sections = [
		`${full}: ${node.summary} (Kody CLI ${readPackageVersion()})`,
		`Usage:\n${node.usage.map((line) => `  ${line}`).join('\n')}`,
	]
	if (node.subcommands?.length) {
		sections.push(
			`Commands:\n${formatRows(
				node.subcommands.map((sub) => [sub.name, sub.summary]),
			)}`,
		)
	}
	sections.push(
		`Flags:\n${formatRows([
			...(node.flags ?? []),
			['-h, --help', 'Show help for this command'],
		])}`,
	)
	if (node.notes?.length) sections.push(node.notes.join('\n'))
	if (node.subcommands?.length) {
		sections.push(`Run \`${full} <command> --help\` for a command's flags.`)
	}
	return `${sections.join('\n\n')}\n`
}
