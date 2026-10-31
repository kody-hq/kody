import { expect, test } from 'vitest'
import { describeRequestingBrowser } from './package-app-device-request.ts'

test('describeRequestingBrowser names the browser and device in plain words', () => {
	expect(
		describeRequestingBrowser(
			'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36 Kindle/3.0',
		),
	).toBe('Kindle browser (Chrome 80)')
	expect(
		describeRequestingBrowser(
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.0 Safari/537.36',
		),
	).toBe('Chrome 80 on Linux')
	expect(
		describeRequestingBrowser(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
		),
	).toBe('Safari 17 on iOS')
	expect(describeRequestingBrowser(null)).toBe('An unknown browser')
})
