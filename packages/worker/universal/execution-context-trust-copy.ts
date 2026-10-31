/**
 * Trust-boundary copy for execution contexts (protocol 8.6). Every place a
 * context is registered, shared or opted into states whose machine runs the
 * code, what its operator can see, what local access it exposes, and what the
 * sharing level means. One module so the snapshot test covers every string.
 *
 * "Credential values stay on Kody" depends on `kody.oauthClientCredentials`
 * returning only a handle (decision 10).
 */
import {
	type ExecutionContextGrantSummary,
	type ExecutionContextPreset,
	type ExecutionContextSharingLevel,
	runtimeLabel,
} from './execution-contexts.ts'

function filesLabel(grant: ExecutionContextGrantSummary) {
	if (grant.fs === 0) return 'none'
	const paths = grant.fs === 1 ? '1 path' : `${grant.fs} paths`
	return grant.fsMode ? `${paths}, ${grant.fsMode}` : paths
}

function internetLabel(grant: ExecutionContextGrantSummary) {
	switch (grant.egress.mode) {
		case 'public':
		case 'public-and-lan':
			return 'public'
		case 'allowlist':
			return grant.egress.hosts === undefined
				? 'allowlist'
				: `allowlist of ${grant.egress.hosts} ${grant.egress.hosts === 1 ? 'host' : 'hosts'}`
		case 'none':
			return 'none'
		default: {
			const exhaustive: never = grant.egress.mode
			return exhaustive
		}
	}
}

function lanEnabled(grant: ExecutionContextGrantSummary) {
	return grant.egress.mode === 'public-and-lan'
}

/** "files: … · local network: … · internet: … · Kody APIs: …" */
function accessLine(grant: ExecutionContextGrantSummary) {
	return [
		`files: ${filesLabel(grant)}`,
		`local network: ${lanEnabled(grant) ? 'yes' : 'no'}`,
		`internet: ${internetLabel(grant)}`,
		`Kody APIs: ${runtimeLabel(grant.runtime)}`,
	].join(' · ')
}

export type OptInCopy = {
	title: string
	paragraphs: Array<string>
	lan: string | null
	managersNote: string
	checkboxLabel: string
	chainFullNote: string
}

export function optInCopy(input: {
	name: string
	operator: string
	grant: ExecutionContextGrantSummary
}): OptInCopy {
	const op = `@${input.operator}`
	return {
		title: `Opt into ${input.name}?`,
		paragraphs: [
			`Your runs will execute on ${input.name}, a machine operated by ${op}. ${op} can see the code, inputs, logs and results of your runs.`,
			`Your runs get this machine's network position and access: ${accessLine(input.grant)}.`,
			`While your run is active, ${op}'s machine can make Kody API calls as you (within that Kody API access), can use your credentials (GitHub, email and any others you've connected) and read the responses, and can change the results your run returns. Your credential values stay in Kody cloud and never reach the machine. Opting in is your consent to this.`,
		],
		lan: lanEnabled(input.grant)
			? `Local network access is on: your runs can reach devices and services on ${op}'s local network.`
			: null,
		managersNote:
			"Context managers see run metadata in the context's run history (who, when, duration, outcome), never results.",
		checkboxLabel: 'Add it to the end of my fallback chain',
		chainFullNote:
			'Your chain is full, so this context will not be added to it.',
	}
}

export const sharingLevelLabels: Record<ExecutionContextSharingLevel, string> =
	{
		only_me: 'Only me',
		people: 'Specific people',
		team: 'Team',
		org: 'Everyone in an org',
	}

export function sharingLevelHelp(input: {
	level: ExecutionContextSharingLevel
	orgSlug: string
	team?: string
}) {
	switch (input.level) {
		case 'only_me':
			return 'Only you can run code here.'
		case 'people':
			return `These people, including people outside @${input.orgSlug}, can run code here after opting in.`
		case 'team':
			return `Members of team ${input.team ?? '{team}'} in @${input.orgSlug} can run code here after opting in.`
		case 'org':
			return `Every member of @${input.orgSlug} can run code here after opting in (not outside collaborators).`
		default: {
			const exhaustive: never = input.level
			return exhaustive
		}
	}
}

export const presetLabels: Record<ExecutionContextPreset, string> = {
	use: 'Use: run code here',
	contribute:
		"Contribute: also rename it and change what it exposes, within the machine's local policy",
	manage: 'Manage: also share, unshare and revoke it',
}

export type ShareCopy = {
	title: string
	paragraphs: Array<string>
	lan: string | null
	firstShareRuntimeNote: string
	ownerWithoutManageNote: string
	noInviteLinksNote: string
}

export function shareCopy(input: {
	name: string
	operator: string
	viewerIsOperator: boolean
	grant: ExecutionContextGrantSummary
}): ShareCopy {
	const op = `@${input.operator}`
	const who = input.viewerIsOperator ? 'You will' : `${op} will`
	return {
		title: `Share ${input.name}`,
		paragraphs: [
			`Anyone you share with can run code on this machine (operated by ${op}) after they opt in. ${who} be able to see their code, inputs, logs and results.`,
			`Their runs get: ${accessLine(input.grant)}.`,
			"While their run is active, this machine can make Kody API calls as them (within that Kody API access), can use their credentials (GitHub, email and any others they've connected) and read the responses, and can change their results. Credential values stay in Kody cloud and never reach this machine.",
		],
		lan: lanEnabled(input.grant)
			? "Local network access is on: their runs can reach devices and services on this machine's local network."
			: null,
		firstShareRuntimeNote:
			"Others' runs can call no Kody APIs until you allow some.",
		ownerWithoutManageNote: `Only ${op} or people with Manage can add access.`,
		noInviteLinksNote:
			'Add people by their Kody username. There are no invite links, so access cannot be forwarded.',
	}
}

export function stopSharingConfirm(subject: string) {
	return `Stop sharing with ${subject}? Their runs on this machine stop now.`
}

export type RegisterCopy = {
	body: string
	commands: Array<string>
	trust: Array<string>
	after: string
	login: string
}

export function registerCopy(input: { orgSlug: string | null }): RegisterCopy {
	return {
		body: 'Registration happens from the CLI because the context key is generated on the machine and never leaves it. On the machine that should run code:',
		commands: [
			'npm install -g @kodycodes/cli',
			'kody login',
			input.orgSlug
				? `kody connect --name my-machine --org ${input.orgSlug}`
				: 'kody connect --name my-machine',
		],
		trust: [
			'Code sent to this context runs on that machine, under the account that runs kody daemon.',
			'It starts as Only me. Your runs on it use your credentials as in Kody cloud: those requests leave from Kody cloud, so the values never reach that machine. Its Kody API allowlist can narrow what runs there may call. If you share it, the people who opt in run code on that machine with their own credentials, and you can see their code, inputs, logs and results, including responses to their credentialed requests. Their runs cannot start workflows there, and Kody APIs kept for Kody cloud refuse them.',
			'What it exposes (files, local network, internet) is set on the machine; the CLI prints it.',
		],
		after:
			'kody connect registers the machine and offers to install kody daemon as a background service (Linux, macOS, and Windows), so it keeps running after reboots and crashes. Check it with kody daemon status. If you skip that, run kody daemon in a terminal or kody daemon install later. It appears here within a few seconds, marked Not in any chain. Add it to your chain to start using it, or share it.',
		login:
			'If your Kody login predates execution context permissions, registering fails and tells you to run `kody login` again first. Other logins keep working as they are.',
	}
}
