import { homedir } from 'node:os'
import checkbox from '@inquirer/checkbox'
import {
	detectRunningHosts,
	listRunningProcesses,
} from './detect-running-hosts.js'
import { hostById, parseHostIds, type HostId } from './host-catalog.js'
import {
	applyHost,
	type ApplyResult,
	type InstallRuntime,
} from './install-hosts.js'
import {
	buildOnboardingContinuationPrompt,
	webClientsOnboardingNote,
} from './onboarding-prompt.js'
import { type ProcessInfo } from './process-info.js'

export type InstallOptions = {
	mcpUrl: string
	clients?: string
	yes?: boolean
	project?: boolean
	json?: boolean
}

export type InstallIo = {
	stdout?: (text: string) => void
	stderr?: (text: string) => void
	isTTY?: boolean
	home?: string
	cwd?: string
	listProcesses?: () => Promise<Array<ProcessInfo>>
	chooseHosts?: (
		hosts: Array<{ id: HostId; label: string }>,
	) => Promise<Array<HostId>>
	runtime?: Partial<InstallRuntime>
}

async function defaultChooseHosts(
	hosts: Array<{ id: HostId; label: string }>,
): Promise<Array<HostId>> {
	return await checkbox({
		message: 'Configure Kody in these running agents',
		choices: hosts.map((host) => ({
			name: host.label,
			value: host.id,
			checked: true,
		})),
		required: false,
	})
}

export async function runInstall(
	options: InstallOptions,
	io: InstallIo = {},
): Promise<{ code: number; results: Array<ApplyResult> }> {
	const write = io.stdout ?? ((text: string) => process.stdout.write(text))
	const mcpUrl = options.mcpUrl
	const home = io.home ?? homedir()
	const cwd = io.cwd ?? process.cwd()
	const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY)
	const listProcesses = io.listProcesses ?? listRunningProcesses
	const detected = detectRunningHosts(await listProcesses())
	const requested = options.clients ? parseHostIds(options.clients) : null

	let selected: Array<HostId>
	if (requested) {
		selected = requested
	} else if (detected.length === 0) {
		write(noRunningAgentsMessage(mcpUrl))
		return { code: 1, results: [] }
	} else if (options.yes || (!isTTY && detected.length === 1)) {
		selected = detected.map((host) => host.id)
	} else if (!isTTY && detected.length > 1) {
		write(
			[
				'Multiple local agents are running. Re-run with --yes or --clients <ids>.',
				`Detected: ${detected.map((host) => host.id).join(', ')}`,
				'',
			].join('\n'),
		)
		return { code: 1, results: [] }
	} else {
		const choose = io.chooseHosts ?? defaultChooseHosts
		selected = await choose(
			detected.map((host) => ({ id: host.id, label: host.label })),
		)
		if (selected.length === 0) {
			write(`No clients selected.\n${webClientsOnboardingNote(mcpUrl)}\n`)
			return { code: 1, results: [] }
		}
	}

	const runtime: InstallRuntime = {
		home,
		cwd,
		project: options.project === true,
		...io.runtime,
	}
	const results: Array<ApplyResult> = []
	for (const id of selected) {
		results.push(await applyHost({ id, mcpUrl, runtime }))
	}

	if (options.json) {
		write(`${JSON.stringify({ mcpUrl, results }, null, 2)}\n`)
	} else {
		write(formatInstallReport({ mcpUrl, results }))
	}
	return { code: 0, results }
}

function noRunningAgentsMessage(mcpUrl: string): string {
	return [
		'No local MCP agents are running.',
		'Start Cursor, Claude Desktop, VS Code, Goose, or another local client, then run kody install again.',
		'Or pass --clients cursor,vscode to configure a client that is not running.',
		webClientsOnboardingNote(mcpUrl),
		'',
	].join('\n')
}

function formatInstallReport(input: {
	mcpUrl: string
	results: Array<ApplyResult>
}): string {
	const lines: Array<string> = []
	for (const result of input.results) {
		const host = hostById(result.id)
		const headline = statusHeadline(result)
		lines.push(`${host.label}: ${headline}`)
		if (result.path) lines.push(`  ${result.path}`)
		if (result.command) lines.push(`  ${result.command}`)
		for (const instruction of result.instructions) {
			lines.push(`  ${instruction}`)
		}
		lines.push('')
	}
	lines.push('Paste this into your agent to continue onboarding:')
	lines.push('')
	lines.push(buildOnboardingContinuationPrompt())
	lines.push('')
	lines.push(webClientsOnboardingNote(input.mcpUrl))
	lines.push('')
	return lines.join('\n')
}

function statusHeadline(result: ApplyResult): string {
	switch (result.status) {
		case 'wrote':
			return 'configured'
		case 'unchanged':
			return 'already configured'
		case 'command':
			return 'added via CLI'
		case 'manual':
			return 'needs a manual step'
		default: {
			const exhaustive: never = result.status
			return exhaustive
		}
	}
}
