import { expect, test } from 'vitest'
import { minifyInlineCss } from './vite-inline-css-text.ts'

test('CSS escape terminators preserve compound and descendant selectors across line endings', async () => {
	for (const newline of ['\r\n', '\r', '\n', '\f']) {
		expect(await minifyInlineCss(`.\\31${newline}.child { color: red; }`)).toBe(
			'.\\31.child{color:red}\n',
		)
		expect(
			await minifyInlineCss(`.\\31${newline} .child { color: red; }`),
		).toBe('.\\31  .child{color:red}\n')
	}
})
