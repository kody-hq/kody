#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [configFile, outputArg] = process.argv.slice(2)
if (!configFile || !outputArg)
	throw new Error('Usage: release.mjs CONFIG NEW_OUTPUT_DIRECTORY')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
for (const target of config.targets) {
	const url = new URL(target.origin)
	if (
		!['localhost', '127.0.0.1'].includes(url.hostname) ||
		url.username ||
		url.password ||
		!/^[a-f0-9]{40}$/.test(target.commit ?? '')
	)
		throw new Error('Expected local origins and full release SHAs')
}
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({
	executablePath:
		config.chromePath ??
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const results = []
try {
	for (const target of config.targets) {
		execFileSync(
			process.execPath,
			[
				new URL('../control-kody.ts', import.meta.url).pathname,
				'health',
				'--origin',
				target.origin,
				'--sha',
				target.commit,
			],
			{ stdio: 'pipe' },
		)
		const prefix = `/__start/${target.commit}/`
		const context = await browser.newContext()
		const page = await context.newPage()
		const fonts = []
		let errors = 0
		page.on('pageerror', () => errors++)
		page.on('console', (message) => {
			if (message.type() === 'error') errors++
		})
		page.on('response', (response) => {
			const path = new URL(response.url()).pathname
			if (path.includes('/fonts/'))
				fonts.push({ path, status: response.status() })
		})
		const pages = []
		try {
			for (const path of ['/', '/pricing', '/docs']) {
				const response = await page.goto(new URL(path, target.origin).href, {
					waitUntil: 'networkidle',
				})
				await page.waitForSelector('html[data-hydrated="true"]')
				const nonce = /'nonce-([^']+)'/.exec(
					response.headers()['content-security-policy'] ?? '',
				)?.[1]
				if (!nonce || response.status() !== 200)
					throw new Error(`Invalid release response: ${target.label}${path}`)
				const details = await page.evaluate(
					({ prefix, nonce }) => {
						const styles = [
							...document.querySelectorAll('style[data-tsr-inline-css]'),
						]
						return {
							heading: document.querySelector('h1')?.textContent,
							inlineStyles: styles.length,
							inlineCssBytes: new TextEncoder().encode(
								styles.map((style) => style.textContent).join(''),
							).byteLength,
							namespacedFonts: styles.some((style) =>
								style.textContent.includes(`${prefix}fonts/`),
							),
							linkedStyles: document.querySelectorAll('link[rel="stylesheet"]')
								.length,
							nonceScripts: [
								'data-kody-document-init',
								'data-kody-emotion-hoist',
							].every((marker) => {
								const script = document.querySelector(`script[${marker}]`)
								return script?.nonce === nonce && !script.hasAttribute('src')
							}),
							namespacedScripts: [...document.scripts]
								.filter((script) => script.src)
								.every((script) =>
									new URL(script.src).pathname.startsWith(prefix),
								),
						}
					},
					{ prefix, nonce },
				)
				if (
					!details.heading ||
					details.inlineStyles !== 1 ||
					!details.inlineCssBytes ||
					!details.namespacedFonts ||
					details.linkedStyles ||
					!details.nonceScripts ||
					!details.namespacedScripts
				)
					throw new Error(
						`Invalid release document: ${target.label}${path} ${JSON.stringify(details)}`,
					)
				pages.push({
					path,
					status: response.status(),
					encoding: response.headers()['content-encoding'],
					...details,
				})
			}
			if (
				errors ||
				fonts.length < 2 ||
				fonts.some(
					(font) =>
						!font.path.startsWith(`${prefix}fonts/`) ||
						![200, 304].includes(font.status),
				)
			)
				throw new Error(
					`Release assets failed: ${target.label}, errors=${errors}`,
				)
			results.push({
				label: target.label,
				commit: target.commit,
				pages,
				fonts,
				errors,
			})
		} finally {
			await context.close()
		}
	}
	writeFileSync(
		join(output, 'proof.json'),
		JSON.stringify({ chrome: browser.version(), results }, null, 2) + '\n',
	)
} finally {
	await browser.close()
}
