import { expect, test } from 'vitest'
import {
	firstTouchAttributionCreateFields,
	firstTouchAttributionToUserColumns,
	hasFirstTouchAttribution,
	parseFirstTouchAttribution,
	readFirstTouchAttributionFromCookie,
	serializeFirstTouchAttributionCookie,
	type FirstTouchAttribution,
} from './first-touch-attribution.ts'

function cookiePair(setCookie: string) {
	return setCookie.split(';')[0]!
}

test('first-touch attribution parses query params and rejects unsafe paths', () => {
	expect(
		parseFirstTouchAttribution({
			searchParams: new URLSearchParams(
				'utm_source=youtube&utm_medium=video&utm_campaign=bwk-2026-08-27&utm_content=desc&utm_term=kody',
			),
			landingPath: '/signup',
			referrer: 'https://youtube.com/watch?v=1',
		}),
	).toEqual({
		utmSource: 'youtube',
		utmMedium: 'video',
		utmCampaign: 'bwk-2026-08-27',
		utmContent: 'desc',
		utmTerm: 'kody',
		landingPath: '/signup',
		referrer: 'https://youtube.com/watch?v=1',
	})

	expect(
		parseFirstTouchAttribution({
			searchParams: new URLSearchParams('utm_source=%20youtube%20'),
			landingPath: '//evil.example',
		}),
	).toMatchObject({ utmSource: 'youtube', landingPath: null })

	const fromRefOnly = parseFirstTouchAttribution({
		searchParams: new URLSearchParams('ref=KentCDodds'),
		landingPath: '/signup',
	})
	expect(fromRefOnly).toMatchObject({ utmSource: null, landingPath: '/signup' })
	expect(hasFirstTouchAttribution(fromRefOnly)).toBe(true)
	expect(firstTouchAttributionToUserColumns(fromRefOnly)).toMatchObject({
		utm_source: null,
		first_touch_landing_path: '/signup',
	})
	expect(firstTouchAttributionCreateFields(fromRefOnly)).toEqual({
		first_touch_landing_path: '/signup',
	})
})

test('kody_first_touch cookie round-trips with kody_ref conventions and clears', () => {
	const attribution = parseFirstTouchAttribution({
		searchParams: new URLSearchParams(
			'utm_source=tanstack&utm_campaign=kody partnership; launch',
		),
		landingPath: '/',
		referrer: 'https://tanstack.com/blog/kody?a=1&b=2',
	})
	const setCookie = serializeFirstTouchAttributionCookie({
		attribution,
		secure: true,
	})
	expect(setCookie).toBe(
		'kody_first_touch=utm_source=tanstack&utm_campaign=kody+partnership%3B+launch&landing_path=%2F&referrer=https%3A%2F%2Ftanstack.com%2Fblog%2Fkody%3Fa%3D1%26b%3D2; Path=/; Max-Age=604800; SameSite=Lax; Secure',
	)
	expect(
		readFirstTouchAttributionFromCookie(
			`kody_ref=ada; ${cookiePair(setCookie)}; theme=dark`,
		),
	).toEqual(attribution)

	expect(
		serializeFirstTouchAttributionCookie({ attribution: null, secure: false }),
	).toBe('kody_first_touch=; Path=/; Max-Age=0; SameSite=Lax')
	expect(readFirstTouchAttributionFromCookie('kody_first_touch=')).toBeNull()
	expect(readFirstTouchAttributionFromCookie('kody_ref=ada')).toBeNull()
	expect(readFirstTouchAttributionFromCookie(null)).toBeNull()
})

test('first-touch cookie keeps the length caps and fits the browser cookie limit', () => {
	// A browser-edited cookie is re-capped on read.
	const edited = readFirstTouchAttributionFromCookie(
		`kody_first_touch=utm_source=${'s'.repeat(300)}&landing_path=%2F${'p'.repeat(600)}&referrer=${'r'.repeat(600)}`,
	)
	expect(edited?.utmSource).toHaveLength(200)
	expect(edited?.landingPath).toHaveLength(500)
	expect(edited?.referrer).toHaveLength(500)

	// Capped ASCII values fit whole.
	const ascii = parseFirstTouchAttribution({
		searchParams: new URLSearchParams({
			utm_source: 's'.repeat(300),
			utm_medium: 'm'.repeat(300),
			utm_campaign: 'c'.repeat(300),
			utm_content: 'n'.repeat(300),
			utm_term: 't'.repeat(300),
		}),
		landingPath: `/${'p'.repeat(600)}`,
		referrer: 'r'.repeat(600),
	})
	expect(
		readFirstTouchAttributionFromCookie(
			cookiePair(
				serializeFirstTouchAttributionCookie({
					attribution: ascii,
					secure: true,
				}),
			),
		),
	).toEqual(ascii)

	// Percent-encoding multibyte values would pass 4096 bytes; the least
	// useful fields drop first and utm_source always stays.
	const wide: FirstTouchAttribution = {
		utmSource: '源'.repeat(200),
		utmMedium: '媒'.repeat(200),
		utmCampaign: '活'.repeat(200),
		utmContent: '内'.repeat(200),
		utmTerm: '词'.repeat(200),
		landingPath: `/${'路'.repeat(499)}`,
		referrer: '引'.repeat(500),
	}
	const setCookie = serializeFirstTouchAttributionCookie({
		attribution: wide,
		secure: true,
	})
	expect(cookiePair(setCookie).length).toBeLessThan(4096)
	const kept = readFirstTouchAttributionFromCookie(cookiePair(setCookie))
	expect(kept).toMatchObject({
		utmSource: wide.utmSource,
		utmMedium: wide.utmMedium,
		referrer: null,
		landingPath: null,
	})
})
