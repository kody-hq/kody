import type { DesktopSetupWizardStep as SetupStep } from './desktop-setup-step-state.ts'
export type DesktopSetupStageId = 'sign-in' | 'register' | 'attach' | 'runner'

type DesktopSetupStageStatus = 'complete' | 'current' | 'upcoming'

export type DesktopSetupWizardStep = SetupStep

export type DesktopSetupStage = {
	id: DesktopSetupStageId
	label: string
	status: DesktopSetupStageStatus
}

/** Fields the setup wizard needs from the desktop bridge snapshot. */
export type DesktopSetupMachineSnapshot = {
	supported: boolean
	blocked: boolean
	signedIn: boolean
	cliReady: boolean
	contextId: string | null
	existingContext?: { id: string; name: string | null } | null
	needsVerification: boolean
	onboardingSeen: boolean
	running: boolean
}

/** Personal registration first; team attach only when a team org is the destination. */
function desktopSetupStageIds(targetOrgSlug: string | null) {
	const stages: Array<DesktopSetupStageId> = ['sign-in', 'register']
	if (targetOrgSlug) stages.push('attach')
	stages.push('runner')
	return stages
}

function desktopSetupStageLabel(
	id: DesktopSetupStageId,
	targetOrgSlug: string | null,
) {
	switch (id) {
		case 'sign-in':
			return 'Sign in as this person'
		case 'register':
			return 'Register this device personally'
		case 'attach':
			return targetOrgSlug
				? `Make available to @${targetOrgSlug}`
				: 'Make available to the team'
		case 'runner':
			return 'Runner connected'
		default: {
			const _exhaustive: never = id
			return _exhaustive
		}
	}
}

export function desktopSetupCompleted(input: {
	cliReady: boolean
	contextId: string | null
	running: boolean
	/** Team attach succeeded for this open (wizard-local). */
	attached?: boolean
	/**
	 * The machine already leads the intended workspace chain (personal when no
	 * target, team when target is set).
	 */
	inChain?: boolean
	targetOrgSlug: string | null
}): ReadonlySet<DesktopSetupStageId> {
	const done = new Set<DesktopSetupStageId>()
	if (input.cliReady || input.contextId) done.add('sign-in')
	const teamReady = Boolean(
		input.attached || (input.targetOrgSlug && input.inChain),
	)
	// Personal registration is not "done" until it leads the personal chain.
	// Team flows treat local contextId as enough; attach is a later stage.
	if (input.contextId && (input.targetOrgSlug || input.inChain)) {
		done.add('register')
	}
	if (input.targetOrgSlug) {
		if (teamReady) done.add('attach')
	}
	// Runner stage requires the process up and this machine first in the chain.
	if (input.contextId && input.running) {
		if (input.targetOrgSlug ? teamReady : input.inChain) done.add('runner')
	}
	return done
}

export function desktopSetupStages(input: {
	targetOrgSlug: string | null
	cliReady: boolean
	contextId: string | null
	running: boolean
	attached?: boolean
	inChain?: boolean
	/** Override which stage is current while a step is active. */
	focus?: DesktopSetupStageId | null
}): Array<DesktopSetupStage> {
	const completed = desktopSetupCompleted(input)
	const ids = desktopSetupStageIds(input.targetOrgSlug)
	const firstOpen = ids.find((id) => !completed.has(id)) ?? null
	const focus =
		input.focus && !completed.has(input.focus) ? input.focus : firstOpen
	return ids.map((id) => ({
		id,
		label: desktopSetupStageLabel(id, input.targetOrgSlug),
		status: completed.has(id)
			? 'complete'
			: id === focus
				? 'current'
				: 'upcoming',
	}))
}

/** Where the wizard should land when opened or after prepare(). */
export function desktopSetupResumeStep(input: {
	targetOrgSlug: string | null
	cliReady: boolean
	contextId: string | null
	running: boolean
	attached?: boolean
	inChain?: boolean
}): DesktopSetupWizardStep {
	const completed = desktopSetupCompleted(input)
	if (!completed.has('sign-in')) return 'overview'
	if (!completed.has('register')) return 'register'
	if (input.targetOrgSlug && !completed.has('attach')) return 'attach'
	if (!completed.has('runner')) return 'register'
	return 'done'
}

export type DesktopSetupPanelAction =
	| { kind: 'setup'; label: 'Set up this machine' }
	| { kind: 'resume'; label: 'Resume setup' }
	| { kind: 'manage'; label: 'Manage setup' }
	| { kind: 'verify'; label: 'Verify this machine' }
	| { kind: 'unavailable'; label: 'Set up this machine'; reason: string }

export function desktopSetupPanelAction(input: {
	state: DesktopSetupMachineSnapshot | undefined
	needsAccountOnboarding: boolean | null
}): DesktopSetupPanelAction {
	const { state, needsAccountOnboarding } = input
	if (!state) {
		return {
			kind: 'unavailable',
			label: 'Set up this machine',
			reason: 'Checking this machine…',
		}
	}
	if (!state.supported) {
		return {
			kind: 'unavailable',
			label: 'Set up this machine',
			reason: 'Local execution is not available on this platform.',
		}
	}
	if (state.blocked) {
		return {
			kind: 'unavailable',
			label: 'Set up this machine',
			reason:
				'This app manages a registration for another workspace. Switch to that account to manage it.',
		}
	}
	if (!state.signedIn) {
		return {
			kind: 'unavailable',
			label: 'Set up this machine',
			reason: 'Sign in to Kody in this app before setting up this machine.',
		}
	}
	if (needsAccountOnboarding) {
		return {
			kind: 'unavailable',
			label: 'Set up this machine',
			reason:
				'Finish account onboarding on the website first. Machine setup opens after that.',
		}
	}
	if (state.needsVerification) {
		return { kind: 'verify', label: 'Verify this machine' }
	}
	if (state.contextId) {
		return { kind: 'manage', label: 'Manage setup' }
	}
	if (state.cliReady || state.existingContext) {
		return { kind: 'resume', label: 'Resume setup' }
	}
	return { kind: 'setup', label: 'Set up this machine' }
}

/**
 * True when the context leads the loaded execution chain. Listed but behind
 * another entry still needs the chain update, so setup is not done.
 */
export function desktopSetupContextFirst(
	chainEntries: ReadonlyArray<{ kind: string; id?: string }> | undefined,
	contextId: string | null,
) {
	if (!contextId || !chainEntries) return false
	const first = chainEntries[0]
	return first?.kind === 'context' && first.id === contextId
}
