import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { passwordManagerIgnoreProps } from '../../client/password-manager-ignore.ts'

function collectClientTsxFiles(dir: string): Array<string> {
	const files: Array<string> = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...collectClientTsxFiles(path))
			continue
		}
		if (entry.name.endsWith('.tsx')) files.push(path)
	}
	return files
}

function findWrappingPasswordRevealLabels(source: string) {
	const wrapping: Array<string> = []
	const openLabel = /<label\b[^>]*>/g
	for (const match of source.matchAll(openLabel)) {
		const start = match.index
		if (start === undefined) continue
		const afterOpen = start + match[0].length
		const close = source.indexOf('</label>', afterOpen)
		if (close === -1) continue
		const inner = source.slice(afterOpen, close)
		if (inner.includes('<PasswordRevealInput')) {
			wrapping.push(inner.trim().slice(0, 80))
		}
	}
	return wrapping
}

test('password reveal input starts hidden with an accessible toggle', async () => {
	const html = await renderToString(
		jsx(PasswordRevealInput, {
			id: 'auth-password',
			name: 'password',
			required: true,
			autoComplete: 'current-password',
			'data-field-ring': true,
		}),
	)

	expect(html).toMatch(/<input[^>]*type="password"/)
	expect(html).toMatch(/id="auth-password"/)
	expect(html).toMatch(/name="password"/)
	expect(html).toMatch(/autoComplete="current-password"/)
	expect(html).toMatch(/type="button"/)
	expect(html).toMatch(/aria-label="Show password"/)
	expect(html).toMatch(/aria-pressed="false"/)
	expect(html).toContain('>Show<')
	expect(html).not.toMatch(/type="submit"/)
})

test('controlled reveal shows text and pressed state', async () => {
	const html = await renderToString(
		jsx(PasswordRevealInput, {
			name: 'value',
			revealNoun: 'secret value',
			revealed: true,
			onRevealedChange: () => {},
			value: 'super-secret',
			readOnly: true,
			...passwordManagerIgnoreProps,
		}),
	)

	expect(html).toMatch(/<input[^>]*type="text"/)
	expect(html).toMatch(/aria-label="Hide secret value"/)
	expect(html).toMatch(/aria-pressed="true"/)
	expect(html).toContain('>Hide<')
	expect(html).toMatch(/data-1p-ignore/)
})

test('PasswordRevealInput call sites use for/id, not a wrapping label', () => {
	const clientRoot = fileURLToPath(new URL('..', import.meta.url))
	const wrapping: Array<string> = []
	for (const path of collectClientTsxFiles(clientRoot)) {
		const source = readFileSync(path, 'utf8')
		if (!source.includes('PasswordRevealInput')) continue
		for (const snippet of findWrappingPasswordRevealLabels(source)) {
			wrapping.push(`${path.slice(clientRoot.length)}: ${snippet}`)
		}
	}
	expect(wrapping).toEqual([])
})
