import { expect, test } from 'vitest'
import {
	resolveOrgChooserMode,
	workspaceScopeActionLabel,
	workspaceScopeAgentNote,
	workspaceScopeKind,
} from './workspace-scope.ts'

test('workspace scope labels keep personal/team and create-flow verbs clear', () => {
	expect(workspaceScopeKind(true)).toBe('personal')
	expect(workspaceScopeKind(false)).toBe('team')
	expect(
		workspaceScopeActionLabel('Creating in', {
			slug: 'jane',
			kind: 'personal',
		}),
	).toBe('Creating in @jane · personal workspace')
	expect(
		workspaceScopeActionLabel('Saving to', { slug: 'acme', kind: 'team' }),
	).toBe('Saving to @acme · team workspace')
	expect(workspaceScopeAgentNote({ slug: 'acme', kind: 'team' })).toContain(
		'Local execute is a compute venue',
	)
	expect(workspaceScopeAgentNote({ slug: 'acme', kind: 'team' })).toContain(
		'cannot be moved',
	)
})

test('org chooser preselects, hides a sole org, and disables a fixed org', () => {
	expect(
		resolveOrgChooserMode({
			orgCount: 1,
			selectedSlug: 'jane',
			fixedSlug: null,
			signedIn: true,
		}),
	).toEqual({ kind: 'hidden', slug: 'jane' })

	expect(
		resolveOrgChooserMode({
			orgCount: 3,
			selectedSlug: 'acme',
			fixedSlug: null,
			signedIn: true,
		}),
	).toEqual({
		kind: 'picker',
		selectedSlug: 'acme',
		disabled: false,
		disabledReason: null,
	})

	const fixed = resolveOrgChooserMode({
		orgCount: 3,
		selectedSlug: 'acme',
		fixedSlug: 'acme',
		signedIn: true,
		fixedReason: 'This agent connection was started for @acme.',
	})
	expect(fixed).toEqual({
		kind: 'picker',
		selectedSlug: 'acme',
		disabled: true,
		disabledReason: 'This agent connection was started for @acme.',
	})
})
