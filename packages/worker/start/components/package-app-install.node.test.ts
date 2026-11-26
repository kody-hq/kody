import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { packageAppDesktopLink } from './package-app-install.tsx'

const { parsePackageAppLink } = createRequire(import.meta.url)(
	'../../../desktop/package-app-links.cjs',
)

test('the browser handoff link opens the app root in the desktop shell', () => {
	const link = packageAppDesktopLink('kent', 'weather')
	expect(link).toBe('kody://app/kent/weather')
	expect(parsePackageAppLink(link)).toEqual({
		owner: 'kent',
		packageName: 'weather',
		path: '/',
	})
})
