/**
 * Labels that keep resource ownership, credential ownership, and compute
 * venue separate. "Local" is a compute venue; it never means personal org.
 */

export type WorkspaceScopeKind = 'personal' | 'team'

export type WorkspaceScope = {
	slug: string
	kind: WorkspaceScopeKind
	/** Display name when known; otherwise callers fall back to `@slug`. */
	displayName?: string | null
}

export function workspaceScopeKind(personal: boolean): WorkspaceScopeKind {
	return personal ? 'personal' : 'team'
}

export function workspaceScopeHandle(slug: string) {
	return `@${slug}`
}

export function workspaceScopeKindLabel(kind: WorkspaceScopeKind) {
	switch (kind) {
		case 'personal':
			return 'personal workspace'
		case 'team':
			return 'team workspace'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

/**
 * Short chip for create/connect flows: "Creating in @acme · team workspace".
 */
export function workspaceScopeActionLabel(
	action: 'Creating in' | 'Saving to' | 'Running as' | 'Connecting in',
	scope: Pick<WorkspaceScope, 'slug' | 'kind'>,
) {
	return `${action} ${workspaceScopeHandle(scope.slug)} · ${workspaceScopeKindLabel(scope.kind)}`
}

/**
 * Agent/CLI prose: owning workspace is not the same as compute venue.
 */
export function workspaceScopeAgentNote(
	scope: Pick<WorkspaceScope, 'slug' | 'kind'>,
) {
	return `This request acts in ${workspaceScopeHandle(scope.slug)} (${workspaceScopeKindLabel(scope.kind)}). Local execute is a compute venue; it does not mean personal workspace. Credentials created in the wrong workspace cannot be moved — reconnect under the right workspace instead.`
}

/**
 * Org chooser policy (Kent): preselect when a default is known; when the org
 * is fixed for the flow, disable the chooser and explain why.
 */
export type OrgChooserMode =
	| { kind: 'hidden'; slug: string }
	| {
			kind: 'picker'
			selectedSlug: string | null
			disabled: boolean
			disabledReason: string | null
	  }
	| { kind: 'missing' }
	| { kind: 'pending' }

export function resolveOrgChooserMode(input: {
	orgCount: number
	selectedSlug: string | null
	/** Org required by the flow (URL `?org=`, callback handoff, scoped auth). */
	fixedSlug: string | null
	signedIn: boolean
	fixedReason?: string | null
}): OrgChooserMode {
	if (input.orgCount === 1 && input.selectedSlug) {
		return { kind: 'hidden', slug: input.selectedSlug }
	}
	if (input.orgCount === 1) {
		return { kind: 'missing' }
	}
	if (input.orgCount < 1) {
		if (input.signedIn) return { kind: 'missing' }
		return { kind: 'pending' }
	}
	if (input.fixedSlug) {
		return {
			kind: 'picker',
			selectedSlug: input.fixedSlug,
			disabled: true,
			disabledReason:
				input.fixedReason ??
				`This flow must use ${workspaceScopeHandle(input.fixedSlug)}. Start again from that workspace to choose a different one.`,
		}
	}
	return {
		kind: 'picker',
		selectedSlug: input.selectedSlug,
		disabled: false,
		disabledReason: null,
	}
}
