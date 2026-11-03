import { expect, test } from 'vitest'
import {
	laterIsoTimestamp,
	normalizeEmailForReferralFraud,
	normalizeReferralCode,
	parseReferralCode,
	referralSharePath,
	resolveAdminPlanOverlay,
	unixSecondsToIso,
} from './referral-program.ts'

const now = new Date('2026-09-07T12:00:00.000Z')

test('referral codes, share links, stacking, overlays, and fraud email collapse', () => {
	expect(normalizeReferralCode(' KentCDodds ')).toBe('kentcdodds')
	expect(normalizeReferralCode('ab')).toBeNull()
	expect(normalizeReferralCode('not valid')).toBeNull()
	expect(
		parseReferralCode({ searchParams: new URLSearchParams('ref=Ada') }),
	).toBe('ada')
	expect(
		parseReferralCode({
			body: { referralCode: 'ada', ref: 'ignored-when-first-wins' },
		}),
	).toBe('ada')
	expect(
		parseReferralCode({ searchParams: new URLSearchParams('ref=x') }),
	).toBe(null)
	expect(referralSharePath('KentCDodds')).toBe('/?ref=kentcdodds')
	expect(referralSharePath('x')).toBe('/')

	expect(
		laterIsoTimestamp(
			null,
			'2026-01-01T00:00:00.000Z',
			'2026-02-01T00:00:00.000Z',
		),
	).toBe('2026-02-01T00:00:00.000Z')
	expect(laterIsoTimestamp('not-a-date', null)).toBeNull()

	expect(normalizeEmailForReferralFraud('Ada+1@Gmail.com')).toBe(
		'ada@gmail.com',
	)
	expect(normalizeEmailForReferralFraud('a.da@googlemail.com')).toBe(
		'ada@gmail.com',
	)
	expect(normalizeEmailForReferralFraud('ada+work@example.com')).toBe(
		'ada@example.com',
	)
	expect(unixSecondsToIso(1_788_782_400)).toBe('2026-09-07T12:00:00.000Z')
	expect(unixSecondsToIso('nope')).toBeNull()
})

test('resolveAdminPlanOverlay exposes expiry columns and which overlay wins', () => {
	const gift = '2026-09-15T00:00:00.000Z'
	const referral = '2026-09-20T00:00:00.000Z'
	expect(
		resolveAdminPlanOverlay({
			manualPlan: 'free',
			stripePlan: null,
			secondAgentGiftExpiresAt: gift,
			referralCreditExpiresAt: null,
			now,
		}),
	).toEqual({
		secondAgentGiftExpiresAt: gift,
		referralCreditExpiresAt: null,
		overlayExpiresAt: gift,
		isProOverlay: true,
		overlayType: 'second_agent_gift',
	})
	expect(
		resolveAdminPlanOverlay({
			manualPlan: 'free',
			stripePlan: null,
			secondAgentGiftExpiresAt: gift,
			referralCreditExpiresAt: referral,
			now,
		}),
	).toEqual({
		secondAgentGiftExpiresAt: gift,
		referralCreditExpiresAt: referral,
		overlayExpiresAt: referral,
		isProOverlay: true,
		overlayType: 'referral_credit',
	})
	expect(
		resolveAdminPlanOverlay({
			manualPlan: 'free',
			stripePlan: null,
			secondAgentGiftExpiresAt: gift,
			referralCreditExpiresAt: gift,
			now,
		}).overlayType,
	).toBe('second_agent_gift')
	expect(
		resolveAdminPlanOverlay({
			manualPlan: 'free',
			stripePlan: 'pro',
			secondAgentGiftExpiresAt: gift,
			referralCreditExpiresAt: referral,
			now,
		}),
	).toMatchObject({
		isProOverlay: false,
		overlayType: null,
		overlayExpiresAt: referral,
	})
	expect(
		resolveAdminPlanOverlay({
			manualPlan: 'free',
			stripePlan: null,
			secondAgentGiftExpiresAt: '2026-08-01T00:00:00.000Z',
			referralCreditExpiresAt: null,
			now,
		}),
	).toMatchObject({
		isProOverlay: false,
		overlayType: null,
		overlayExpiresAt: '2026-08-01T00:00:00.000Z',
	})
})
