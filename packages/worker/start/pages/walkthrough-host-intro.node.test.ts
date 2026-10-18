import { expect, test } from 'vitest'
import { build } from 'esbuild'
import { resolve } from 'node:path'

// Bundle the actual component and Emotion together so the production Redact
// aliases apply inside Emotion too. The node-unit project otherwise uses React
// for external packages and Remix's JSX default for legacy component tests.
async function renderActualIntro(
	renderer: 'react' | 'redact',
	publicBase = '/',
) {
	const root = resolve(import.meta.dirname, '../../../..')
	const result = await build({
		stdin: {
			resolveDir: root,
			contents: `
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { CacheProvider } from '@emotion/react'
import createCache from '@emotion/cache'
import { WalkthroughHostIntro } from './packages/worker/start/pages/walkthrough-host-intro.tsx'
import { pickWalkthroughHosts } from './packages/worker/universal/walkthrough-hosts.ts'
const hosts = pickWalkthroughHosts(() => 0)
export const selected = ['coding', 'invoke', 'notify'].map(slot => hosts[slot])
export const rendered = ['sentence', 'picker'].map(variant => renderToString(
 createElement(CacheProvider, { value: createCache({ key: 'intro' }) },
  createElement(WalkthroughHostIntro, { hosts, variant, onHostsChange() {} }))
))
`,
		},
		banner: {
			js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(resolve(root, 'package.json'))});`,
		},
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
		define: { 'import.meta.env.BASE_URL': JSON.stringify(publicBase) },
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: {
			'#universal': resolve(root, 'packages/worker/universal'),
			...(renderer === 'redact'
				? {
						react: '@tanstack/redact',
						'react-dom/server': '@tanstack/redact/server',
					}
				: {}),
		},
	})
	const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`
	return (await import(/* @vite-ignore */ url)) as {
		rendered: Array<string>
		selected: Array<{ id: string; label: string }>
	}
}

for (const renderer of ['react', 'redact'] as const) {
	test(`${renderer} SSR uses native select children and keeps selected marks outside the control`, async () => {
		const { rendered, selected } = await renderActualIntro(renderer)
		for (const html of rendered) {
			const selects = [
				...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g),
			].map((match) => match[0])
			expect(selects).toHaveLength(3)
			for (const [index, select] of selects.entries()) {
				// Older Safari parses only native option content inside a select.
				// Extra button/span/style nodes are discarded before hydration.
				expect(select).not.toMatch(/<(?:button|span|style|img)\b/i)
				const children = select.replace(/^<select\b[^>]*>|<\/select>$/g, '')
				expect(children).toMatch(/^(?:<option\b[^>]*>[^<]*<\/option>)+$/)
				expect(select).not.toContain('--chip-icon:')
				expect(select).toContain(selected[index]!.label)
				const selectedOption = [...select.matchAll(/<option\b[^>]*>/g)].find(
					(match) => match[0].includes(`value="${selected[index]!.id}"`),
				)?.[0]
				expect(selectedOption).toMatch(/\bselected(?:=|\s|>)/)
			}
			expect(html.match(/class="walkthrough-host-mark"/g)).toHaveLength(3)
			expect(html).toContain('mask-image:var(--chip-icon)')
			expect(html).not.toContain('appearance:base-select')
			expect(html).toContain('/images/icons/')
		}
	})
}

for (const renderer of ['react', 'redact'] as const) {
	test(`${renderer} SSR uses the release asset base supplied by the build`, async () => {
		const base = `/__start/${'d'.repeat(40)}/`
		const { rendered } = await renderActualIntro(renderer, base)
		for (const html of rendered) {
			expect(html).toContain(`${base}images/icons/`)
			expect(html).not.toContain('url("/images/icons/')
		}
	})
}
