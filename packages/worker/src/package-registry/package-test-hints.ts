import {
	buildMultiTriggerEnablementHint,
	formatEnablementEnableCall,
	isEmailSubscriptionTopic,
	type EnablementHintTrigger,
} from '#worker/enablements/enablement-agent-hints.ts'

export type PackageTestHints = {
	app?: string
	subscriptions?: Array<{
		topic: string
		snippet: string
	}>
	/**
	 * Agent-directed follow-up when declared triggers are not on for the
	 * publisher. Ask the user, then call enablementEnable / Approve.
	 */
	enablements?: {
		message: string
		triggers: Array<{
			kind: EnablementHintTrigger['kind']
			name: string
			reason: EnablementHintTrigger['reason']
			call: string | null
		}>
	}
}

export function buildPackageTestHints(input: {
	packageId: string
	kodyId?: string | null
	hasApp: boolean
	subscriptionTopics: ReadonlyArray<string>
	enablementTriggers?: ReadonlyArray<EnablementHintTrigger>
}): PackageTestHints | undefined {
	const packageIdentity = `package_id: ${JSON.stringify(input.packageId)}`
	const subscriptions = [...new Set(input.subscriptionTopics)]
		.sort((left, right) => left.localeCompare(right))
		.map((topic) => ({
			topic,
			snippet: `packageSubscriptionDispatch({ ${packageIdentity}, topic: ${JSON.stringify(topic)}, params: {} })`,
		}))
	const enablementTriggers = [...(input.enablementTriggers ?? [])]
	const enablementsMessage = buildMultiTriggerEnablementHint({
		packageId: input.packageId,
		kodyId: input.kodyId,
		triggers: enablementTriggers,
	})
	const enablements =
		enablementsMessage == null
			? undefined
			: {
					message: enablementsMessage,
					triggers: enablementTriggers.map((trigger) => ({
						kind: trigger.kind,
						name: trigger.name,
						reason: trigger.reason,
						call:
							trigger.kind === 'webhook' ||
							isEmailSubscriptionTopic(trigger.name)
								? null
								: formatEnablementEnableCall({
										packageId: input.packageId,
										kodyId: input.kodyId,
										triggerKind: trigger.kind,
										triggerName: trigger.name,
									}),
					})),
				}
	if (!input.hasApp && subscriptions.length === 0 && !enablements) {
		return undefined
	}
	return {
		...(input.hasApp
			? {
					app: `appFetch({ ${packageIdentity}, synthetic: true })`,
				}
			: {}),
		...(subscriptions.length > 0 ? { subscriptions } : {}),
		...(enablements ? { enablements } : {}),
	}
}
