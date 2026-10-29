const automationQueueDefaultMinutes = 60
export const automationQueueMaxMinutes = 24 * 60
export const automationChainMaxContexts = 3

type AutomationExecutionMode = 'cloud' | 'context' | 'chain'

export type AutomationExecutionForm = {
	mode: AutomationExecutionMode
	context: string
	fallbackToChain: boolean
	chain: Array<string>
	cloudLast: boolean
	requires: Array<'fs' | 'lan'>
	whenOffline: 'fail' | 'queue'
	queueMinutes: number
}

export type AutomationExecutionValue = {
	context?: string
	fallback?: 'chain'
	chain?: Array<string>
	requires?: Array<'fs' | 'lan'>
	whenOffline?: 'fail' | 'queue'
	queueMinutes?: number
}

/** One automation's setting as the get/set capabilities describe it. */
export type AutomationExecutionSettingView = {
	declared: AutomationExecutionValue | null
	override: AutomationExecutionValue | null
	effective: AutomationExecutionValue | null
	contextRunnable: boolean
}

export function emptyAutomationExecutionForm(): AutomationExecutionForm {
	return {
		mode: 'cloud',
		context: '',
		fallbackToChain: false,
		chain: [],
		cloudLast: false,
		requires: [],
		whenOffline: 'fail',
		queueMinutes: automationQueueDefaultMinutes,
	}
}

function stringArray(value: unknown) {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: []
}

export function automationExecutionFormFrom(
	value: unknown,
	contexts: ReadonlyArray<{ id: string; name: string }> = [],
): AutomationExecutionForm {
	const form = emptyAutomationExecutionForm()
	const idFor = (ref: string) =>
		contexts.find((context) => context.id === ref || context.name === ref)
			?.id ?? ref
	if (!value || typeof value !== 'object') return form
	const setting = value as Record<string, unknown>
	const chain = stringArray(setting.chain)
	form.requires = stringArray(setting.requires).filter(
		(entry): entry is 'fs' | 'lan' => entry === 'fs' || entry === 'lan',
	)
	form.whenOffline = setting.whenOffline === 'queue' ? 'queue' : 'fail'
	if (typeof setting.queueMinutes === 'number') {
		form.queueMinutes = setting.queueMinutes
	}
	if (setting.context === 'cloud') {
		form.mode = 'cloud'
	} else if (typeof setting.context === 'string') {
		form.mode = 'context'
		form.context = idFor(setting.context)
		form.fallbackToChain = setting.fallback === 'chain'
	} else if (chain.length) {
		form.mode = 'chain'
		form.cloudLast = chain.at(-1) === 'cloud'
		form.chain = chain.filter((entry) => entry !== 'cloud').map(idFor)
	}
	return form
}

/**
 * Form state as the `execution` setting. Cloud is explicit (`context: "cloud"`)
 * so it can override a manifest context; null only clears the override.
 */
export function automationExecutionFromForm(
	form: AutomationExecutionForm,
): AutomationExecutionValue | null {
	const routing: AutomationExecutionValue = {}
	if (form.mode === 'context') {
		if (!form.context) return null
		routing.context = form.context
		if (form.fallbackToChain) routing.fallback = 'chain'
	} else if (form.mode === 'chain') {
		const chain = form.chain
			.filter(Boolean)
			.slice(0, automationChainMaxContexts)
		if (form.cloudLast) chain.push('cloud')
		if (!chain.length) return null
		routing.chain = chain
	} else if (!form.requires.length) {
		return { context: 'cloud' }
	}
	if (form.requires.length) routing.requires = [...form.requires]
	if (form.whenOffline === 'queue') {
		routing.whenOffline = 'queue'
		routing.queueMinutes = Math.min(
			automationQueueMaxMinutes,
			Math.max(1, Math.round(form.queueMinutes)),
		)
	}
	return routing
}

export function describeAutomationExecution(
	value: AutomationExecutionValue | null,
	nameFor: (ref: string) => string = (ref) => ref,
) {
	if (!value || (value.context === 'cloud' && !value.requires?.length)) {
		return 'Kody cloud'
	}
	const target = value.context
		? `${nameFor(value.context)}${value.fallback === 'chain' ? ', then your chain' : ' only'}`
		: value.chain
			? value.chain
					.map((ref) => (ref === 'cloud' ? 'Kody cloud' : nameFor(ref)))
					.join(' → ')
			: 'your chain'
	const requires = value.requires?.length
		? ` · needs ${value.requires.join(' + ')}`
		: ''
	const offline =
		value.whenOffline === 'queue'
			? ` · queues up to ${value.queueMinutes ?? automationQueueDefaultMinutes} min when offline`
			: ' · fails when offline'
	return `${target}${requires}${offline}`
}
