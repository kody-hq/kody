import { expect, test } from 'vitest'
import {
	desktopSetupCompleted,
	desktopSetupPanelAction,
	desktopSetupResumeStep,
	desktopSetupStages,
} from './desktop-setup-stages.ts'

const base = {
	supported: true,
	blocked: false,
	signedIn: true,
	cliReady: false,
	contextId: null as string | null,
	existingContext: null as { id: string; name: string | null } | null,
	needsVerification: false,
	onboardingSeen: false,
	running: false,
}

test('personal setup lists sign-in, register, and runner', () => {
	expect(
		desktopSetupStages({
			targetOrgSlug: null,
			cliReady: false,
			contextId: null,
			running: false,
		}).map((stage) => [stage.id, stage.status]),
	).toEqual([
		['sign-in', 'current'],
		['register', 'upcoming'],
		['runner', 'upcoming'],
	])
})

test('team destination inserts attach before runner and resumes there after register', () => {
	const stages = desktopSetupStages({
		targetOrgSlug: 'acme',
		cliReady: true,
		contextId: 'ec_mac',
		running: true,
		attached: false,
	})
	expect(stages.map((stage) => [stage.id, stage.status])).toEqual([
		['sign-in', 'complete'],
		['register', 'complete'],
		['attach', 'current'],
		['runner', 'upcoming'],
	])
	expect(
		desktopSetupResumeStep({
			targetOrgSlug: 'acme',
			cliReady: true,
			contextId: 'ec_mac',
			running: true,
			attached: false,
		}),
	).toBe('attach')
	expect(
		desktopSetupCompleted({
			targetOrgSlug: 'acme',
			cliReady: true,
			contextId: 'ec_mac',
			running: true,
			attached: true,
		}),
	).toEqual(new Set(['sign-in', 'register', 'attach', 'runner']))
})

test('panel actions stay available and name resume versus unavailable reasons', () => {
	expect(
		desktopSetupPanelAction({
			state: undefined,
			needsAccountOnboarding: null,
		}).kind,
	).toBe('unavailable')
	expect(
		desktopSetupPanelAction({
			state: { ...base, supported: false },
			needsAccountOnboarding: false,
		}),
	).toMatchObject({
		kind: 'unavailable',
		reason: expect.stringMatching(/not available/i),
	})
	expect(
		desktopSetupPanelAction({
			state: { ...base, cliReady: true },
			needsAccountOnboarding: false,
		}),
	).toEqual({ kind: 'resume', label: 'Resume setup' })
	expect(
		desktopSetupPanelAction({
			state: {
				...base,
				existingContext: { id: 'ec_old', name: 'old-laptop' },
			},
			needsAccountOnboarding: false,
		}),
	).toEqual({ kind: 'resume', label: 'Resume setup' })
	expect(
		desktopSetupPanelAction({
			state: { ...base, contextId: 'ec_mac', onboardingSeen: true },
			needsAccountOnboarding: false,
		}),
	).toEqual({ kind: 'manage', label: 'Manage setup' })
	expect(
		desktopSetupPanelAction({
			state: base,
			needsAccountOnboarding: true,
		}),
	).toMatchObject({
		kind: 'unavailable',
		reason: expect.stringMatching(/account onboarding/i),
	})
})
