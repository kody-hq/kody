/**
 * Trust-boundary wording (protocol 8.6) shared by the CLI output, MCP and
 * Open API responses, and sharing responses, so every surface says the same
 * thing about whose machine runs the code and what its operator sees.
 */

export const registrationTrustLines = [
	'Code sent to this context runs on this machine, under the account that runs kody daemon.',
	'It starts as Only me. Your runs on it use your credentials as in Kody cloud: those requests leave from Kody cloud, so the values never reach this machine. Its Kody API allowlist can narrow what runs here may call. If you share it, the people who opt in run code on this machine with their own credentials, and you can see their code, inputs, logs and results, including responses to their credentialed requests. Their runs cannot start workflows here, and Kody APIs kept for Kody cloud refuse them.',
	'What it exposes (files, local network, internet) is set on this machine by its local policy.',
] as const

export function registrationTrustNotice() {
	return registrationTrustLines.join(' ')
}

export function sharingTrustNotice(input: {
	operatorHandle: string | null
	localNetwork: boolean
}) {
	const operator = input.operatorHandle
		? `@${input.operatorHandle}`
		: 'its operator'
	const lines = [
		`Anyone you share with can run code on this machine (operated by ${operator}) after they opt in. ${operator} can see their code, inputs, logs and results.`,
		"While their run is active, this machine can make Kody API calls as them (within the Kody API access the grant allows), can use their credentials (GitHub, email and any others they've connected) and read the responses, and can change their results. Credential values stay in Kody cloud and never reach this machine.",
	]
	if (input.localNetwork) {
		lines.push(
			"Local network access is on: their runs can reach devices and services on this machine's local network.",
		)
	}
	return lines.join(' ')
}

export function optInTrustNotice(input: {
	name: string
	operatorHandle: string | null
	localNetwork: boolean
}) {
	const operator = input.operatorHandle
		? `@${input.operatorHandle}`
		: 'its operator'
	const lines = [
		`Your runs will execute on ${input.name}, a machine operated by ${operator}. ${operator} can see the code, inputs, logs and results of your runs.`,
		`While your run is active, ${operator}'s machine can make Kody API calls as you (within the Kody API access its grant allows), can use your credentials (GitHub, email and any others you've connected) and read the responses, and can change the results your run returns. Your credential values stay in Kody cloud and never reach the machine. Opting in is your consent to this.`,
	]
	if (input.localNetwork) {
		lines.push(
			`Local network access is on: your runs can reach devices and services on ${operator}'s local network.`,
		)
	}
	return lines.join(' ')
}

export type RegistrationNextStep = {
	kind: 'add_to_chain' | 'share'
	text: string
	cli?: string
	mcp: { capability: string }
	api: { method: string; path: string }
}

export function registrationNextSteps(input: {
	name: string
}): Array<RegistrationNextStep> {
	return [
		{
			kind: 'add_to_chain',
			text: `${input.name} is registered but not in any chain, so no runs use it yet. Add it to your execution chain to start using it. Contexts go before Kody cloud, which is always the last entry when present.`,
			cli: `kody chain add ${input.name}`,
			mcp: { capability: 'executionChainSet' },
			api: { method: 'PUT', path: '/v1/execution-chain' },
		},
		{
			kind: 'share',
			text: `Optional: share ${input.name} with people, a team, or everyone in the org. Sharing lets them run code on this machine with their own credentials after they opt in.`,
			mcp: { capability: 'executionContextShareSet' },
			api: {
				method: 'PUT',
				path: '/v1/execution-contexts/{id}/sharing',
			},
		},
	]
}
