import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { ProviderMark, ProviderIcon } from '../components/provider-icons.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'
test('provider marks prefer uploaded logos, then catalog, favicon and letter', async () => {
	for (const [props, source, path] of [
		[
			{
				logoPath: '/upload.png',
				catalogLogoPath: '/catalog.png',
				autoLogoPath: '/favicon.png',
			},
			'upload',
			'/upload.png',
		],
		[
			{ catalogLogoPath: '/catalog.png', autoLogoPath: '/favicon.png' },
			'catalog',
			'/catalog.png',
		],
		[{ autoLogoPath: '/favicon.png' }, 'favicon', '/favicon.png'],
		[{}, 'letter', null],
	] as const) {
		const html = await renderStartPage(
			jsx(ProviderMark, { providerKey: 'example', label: 'Example', ...props }),
		)
		expect(html).toContain(`data-source="${source}"`)
		if (path) expect(html).toContain(`src="${path}"`)
		else expect(html).toContain('>E</span>')
	}
})
test('known social providers render SVG marks and unknown identifiers do not invent icons', async () => {
	for (const providerId of ['github', 'google', 'discord', 'x'])
		expect(await renderStartPage(jsx(ProviderIcon, { providerId }))).toContain(
			'<svg',
		)
	expect(
		await renderStartPage(jsx(ProviderIcon, { providerId: 'unknown' })),
	).not.toContain('<svg')
})
