import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { executeE2eD1Command, seedUserInE2eDatabase } from '../d1-utils.ts'
import { seedStableUserIdFromEmail } from '../../tools/seed-sql.ts'
import { expect } from '../playwright-utils.ts'

export type Theme = 'light' | 'dark'
export const themes: Theme[] = ['light', 'dark']

export const viewports = {
	desktop: { width: 1280, height: 800 },
	mobile: { width: 390, height: 844 },
} as const
export type ViewportName = keyof typeof viewports

/**
 * How a target is compared with its committed baseline:
 * - `sections`: one baseline per `[data-ui-gallery-section]` (the gallery)
 * - `page`: one full-page baseline
 * - `none`: content varies per run (ids, dates); screenshot and scan only
 */
export type VisualCheck =
	| { kind: 'sections' }
	| { kind: 'page'; mask?: string[] }
	| { kind: 'none'; reason: string }

export type UiVerifyTarget = {
	id: string
	path: string
	session: 'anonymous' | 'user' | 'admin'
	visual: VisualCheck
	ready: (page: Page) => Promise<void>
	prepare?: () => Promise<void>
	/** Selector axe skips, with the owner of the known violation. */
	axeExclude?: string
}

/**
 * Hydration enables the auth submit button and fades it from the disabled
 * 0.7 opacity. Axe blends that opacity into the measured colours, so a scan
 * mid-fade reports a false contrast failure (#4507).
 */
async function expectSubmitSettled(page: Page) {
	const submit = page.getByRole('button', {
		name: /^(Sign in|Create account)$/,
	})
	await expect(submit).toBeEnabled()
	await expect(submit).toHaveCSS('opacity', '1')
}

export const uiVerifyTargets: UiVerifyTarget[] = [
	{
		id: 'guest-claim-merge',
		path: '/claim/uiverifyguestclaimabcdef',
		session: 'user',
		visual: { kind: 'none', reason: 'guest expiry dates vary per run' },
		prepare: async () => {
			const email = 'ui-verify-guest@guest.kody.invalid'
			await seedUserInE2eDatabase({
				email,
				username: 'ui-verify-guest',
				password: 'ui-verify-guest-password',
			})
			const personId = seedStableUserIdFromEmail(email)
			const hash = createHash('sha256')
				.update('guest-claim-url:uiverifyguestclaimabcdef')
				.digest('hex')
			const now = new Date()
			const expires = new Date(now.getTime() + 86400000).toISOString()
			const deleteAt = new Date(now.getTime() + 8 * 86400000).toISOString()
			executeE2eD1Command(`UPDATE users SET guest_expires_at = '${expires}' WHERE stable_user_id = '${personId}';
				INSERT INTO guest_accounts (person_id, personal_org_id, claim_code, client_name, guest_slug, expires_at, delete_at, created_at)
				VALUES ('${personId}', '${personId}', '${hash}', 'UI verify agent', 'ui-verify-guest', '${expires}', '${deleteAt}', '${now.toISOString()}')
				ON CONFLICT(person_id) DO UPDATE SET claim_code = excluded.claim_code, expires_at = excluded.expires_at, delete_at = excluded.delete_at, claimed_at = NULL;`)
		},
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'Move it into kody', exact: true }),
			).toBeVisible()
			await expect(
				page.getByText(
					'The agent connection that created this guest keeps working',
					{ exact: false },
				),
			).toBeVisible()
		},
	},
	{
		id: 'gallery',
		path: '/dev/ui',
		session: 'anonymous',
		visual: { kind: 'sections' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'UI gallery', level: 1 }),
			).toBeVisible()
		},
	},
	{
		id: 'home',
		path: '/',
		session: 'anonymous',
		// The loader shuffles the agent marquee and walkthrough hosts per request.
		visual: { kind: 'page', mask: ['.landing-agents-row', '.landing-proof'] },
		ready: async (page) => {
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		},
	},
	{
		id: 'login',
		path: '/login',
		session: 'anonymous',
		visual: { kind: 'page' },
		// signup-gateway owns this invalid aria-pressed link.
		axeExclude: 'a[aria-pressed]',
		ready: async (page) => {
			await expect(page.getByLabel('Email')).toBeVisible()
			await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
			await expectSubmitSettled(page)
		},
	},
	{
		id: 'signup',
		path: '/signup',
		session: 'anonymous',
		visual: { kind: 'page' },
		axeExclude: 'a[aria-pressed]',
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'Create your account' }),
			).toBeVisible()
			await expect(
				page.getByRole('textbox', { name: 'Username' }),
			).toBeVisible()
			await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
			await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
			await expectSubmitSettled(page)
		},
	},
	{
		id: 'not-found',
		path: '/this-page-does-not-exist',
		session: 'anonymous',
		visual: { kind: 'page' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', {
					name: "This doesn't quite connect.",
					level: 1,
				}),
			).toBeVisible()
			await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible()
		},
	},
	{
		id: 'account',
		path: '/account',
		session: 'user',
		visual: { kind: 'page' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', {
					level: 1,
					name: 'Account settings',
					exact: true,
				}),
			).toBeVisible()
		},
	},
	{
		id: 'onboarding',
		path: '/onboarding',
		session: 'user',
		// The featured agent grid is shuffled per session.
		visual: { kind: 'page', mask: ['[data-testid="onboarding-agent-picker"]'] },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: /Get started with\s*Kody/i }),
			).toBeVisible()
		},
	},
	{
		id: 'admin-users',
		path: '/admin/users',
		session: 'admin',
		visual: { kind: 'none', reason: 'lists every seeded user' },
		ready: async (page) => {
			await expect(
				page.getByRole('heading', { name: 'Admin users', exact: true }),
			).toBeVisible()
		},
	},
]
