import { afterEach, expect, test } from 'vitest'
import {
	firstTouchAttributionCookieName,
	readFirstTouchAttributionFromCookie,
} from '#universal/first-touch-attribution.ts'
import { captureFirstTouchAttributionFromLocation } from './first-touch-attribution.ts'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

afterEach(() => {
	if (originalDocument) {
		Object.defineProperty(globalThis, 'document', originalDocument)
	} else {
		Reflect.deleteProperty(globalThis, 'document')
	}
})

/** One browser cookie jar; every tab on the origin shares it. */
function installCookieJar() {
	const jar = new Map<string, string>()
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			referrer: '',
			get cookie() {
				return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
			},
			set cookie(serialized: string) {
				const [pair = '', ...attributes] = serialized.split(';')
				const separator = pair.indexOf('=')
				const name = pair.slice(0, separator).trim()
				const expired = attributes.some((attribute) =>
					/^\s*max-age=0\s*$/i.test(attribute),
				)
				if (expired) jar.delete(name)
				else jar.set(name, pair.slice(separator + 1))
			},
		},
	})
	return {
		header: () => (globalThis.document as Document).cookie,
		raw: () => jar.get(firstTouchAttributionCookieName),
	}
}

test('first touch wins across tabs and survives closing the landing tab', () => {
	const jar = installCookieJar()

	// Tab 1: click through from the TanStack post, then close the tab.
	captureFirstTouchAttributionFromLocation(
		'https://kody.codes/?utm_source=tanstack&utm_medium=blog&utm_campaign=partnership',
		'https://tanstack.com/',
		true,
	)
	// Tab 2, later: open /signup directly and follow another campaign link.
	captureFirstTouchAttributionFromLocation(
		'https://kody.codes/signup',
		null,
		true,
	)
	captureFirstTouchAttributionFromLocation(
		'https://kody.codes/signup?utm_source=youtube&ref=Ada',
		'https://youtube.com/',
		true,
	)

	expect(readFirstTouchAttributionFromCookie(jar.header())).toEqual({
		utmSource: 'tanstack',
		utmMedium: 'blog',
		utmCampaign: 'partnership',
		utmContent: null,
		utmTerm: null,
		landingPath: '/',
		referrer: 'https://tanstack.com/',
	})
})

test('a visit without UTMs still records the landing path as first touch', () => {
	const jar = installCookieJar()
	captureFirstTouchAttributionFromLocation(
		'https://kody.codes/community',
		null,
		false,
	)
	captureFirstTouchAttributionFromLocation(
		'https://kody.codes/?utm_source=youtube',
		null,
		false,
	)
	expect(jar.raw()).toBe('landing_path=%2Fcommunity')
})

test('blocked cookies (sandboxed iframe SecurityError) do not throw', () => {
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			get cookie(): string {
				throw new DOMException('The operation is insecure.', 'SecurityError')
			},
			set cookie(_value: string) {
				throw new DOMException('The operation is insecure.', 'SecurityError')
			},
		},
	})
	expect(() =>
		captureFirstTouchAttributionFromLocation(
			'https://kody.codes/?utm_source=tanstack',
			null,
			true,
		),
	).not.toThrow()
})
