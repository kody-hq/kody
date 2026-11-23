import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	buildAppCheckReport,
	formatAppCheckMarkdown,
	type AppCheckScreenshot,
	type AppCheckVariantAxe,
	type AxeImpact,
} from '../src/app-check/report.ts'

const screenshots: Array<AppCheckScreenshot> = (
	[
		['desktop', 'light'],
		['desktop', 'dark'],
		['mobile', 'light'],
		['mobile', 'dark'],
	] as const
).map(([viewport, colorScheme]) => ({
	viewport,
	colorScheme,
	path: `/out/${viewport}-${colorScheme}.png`,
	status: 200,
}))

const goodScores = {
	performance: 80,
	accessibility: 100,
	'best-practices': 96,
	seo: 92,
}

function violation(id: string, impact: AxeImpact, selectors: Array<string>) {
	return {
		id,
		impact,
		help: `${id} help`,
		helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`,
		description: `${id} description`,
		nodes: selectors.map((selector) => ({
			target: [selector],
			html: `<div class="${selector}"></div>`,
			failureSummary: 'Fix it',
		})),
	}
}

function build(input: {
	axe?: Array<AppCheckVariantAxe>
	scores?: typeof goodScores
	consoleMessages?: Array<string>
	lighthouseError?: string
	status?: number
}) {
	return buildAppCheckReport({
		package: { name: '@me/app', root: '/pkg' },
		url: 'http://app--me.localhost:4100/',
		target: 'mock',
		checkedAt: '2026-11-22T00:00:00.000Z',
		outputDir: '/out',
		screenshots: screenshots.map((shot) => ({
			...shot,
			status: input.status ?? shot.status,
		})),
		axe: input.axe ?? [],
		lighthouse: {
			scores: input.scores ?? goodScores,
			...(input.lighthouseError ? { error: input.lighthouseError } : {}),
		},
		consoleEntries: (input.consoleMessages ?? []).map((message) => ({
			source: 'browser' as const,
			message,
		})),
	})
}

test('a clean app passes with a short summary and every section', () => {
	const report = build({})
	assert.equal(report.result, 'pass')
	assert.deepEqual(report.issues, [])
	const markdown = formatAppCheckMarkdown(report)
	assert.match(markdown, /^# kody app check: @me\/app\n\nResult: PASS\./)
	for (const heading of [
		'## Screenshots',
		'## Accessibility violations',
		'## Lighthouse scores',
		'## Console errors',
	]) {
		assert.ok(markdown.includes(heading), heading)
	}
	for (const shot of screenshots) assert.ok(markdown.includes(shot.path))
	assert.match(markdown, /- Best practices: 96 \(target 90\)/)
	assert.doesNotMatch(markdown, /\u2014/)
})

test('accessibility rules merge across variants and sort by severity', () => {
	const report = build({
		axe: [
			{
				viewport: 'desktop',
				colorScheme: 'light',
				violations: [
					violation('region', 'moderate', ['main']),
					violation('image-alt', 'critical', ['img.hero']),
				],
			},
			{
				viewport: 'mobile',
				colorScheme: 'dark',
				violations: [
					violation('color-contrast', 'serious', ['p.muted', 'a.link']),
					violation('image-alt', 'critical', ['img.hero', 'img.logo']),
				],
			},
		],
	})
	assert.deepEqual(
		report.accessibility.rules.map((rule) => [rule.id, rule.impact]),
		[
			['image-alt', 'critical'],
			['color-contrast', 'serious'],
			['region', 'moderate'],
		],
	)
	const imageAlt = report.accessibility.rules[0]!
	assert.deepEqual(imageAlt.selectors, ['img.hero', 'img.logo'])
	assert.deepEqual(imageAlt.variants, ['desktop-light', 'mobile-dark'])
	assert.equal(report.result, 'fail')
	assert.match(
		report.summary,
		/^Result: FAIL\. Most important issue: Accessibility \(critical\) image-alt/,
	)
})

test('moderate accessibility rules alone still pass and are named as next', () => {
	const report = build({
		axe: [
			{
				viewport: 'desktop',
				colorScheme: 'light',
				violations: [violation('region', 'moderate', ['main'])],
			},
		],
	})
	assert.equal(report.result, 'pass')
	assert.match(report.summary, /Worth fixing next: region \(moderate\)/)
})

test('markdown caps rules and console errors at 10; json keeps them all', () => {
	const rules = Array.from({ length: 13 }, (_, index) =>
		violation(`rule-${String(index).padStart(2, '0')}`, 'minor', [
			`#n${index}`,
		]),
	)
	const consoleMessages = Array.from(
		{ length: 12 },
		(_, index) => `boom ${index}`,
	)
	const report = build({
		axe: [{ viewport: 'desktop', colorScheme: 'light', violations: rules }],
		consoleMessages: [...consoleMessages, 'boom 0', 'boom 0'],
	})
	assert.equal(report.accessibility.rules.length, 13)
	assert.equal(report.console.errors.length, 12)
	assert.equal(report.console.errors[0]!.message, 'boom 0')
	assert.equal(report.console.errors[0]!.count, 3)
	assert.equal(report.console.entries.length, 14)
	const markdown = formatAppCheckMarkdown(report)
	assert.match(markdown, /And 3 more rules in app-check\.json\./)
	assert.match(markdown, /And 2 more errors in app-check\.json\./)
	assert.match(markdown, /- `boom 0` \(3 times\)/)
	assert.equal((markdown.match(/^- \*\*minor\*\*/gm) ?? []).length, 10)
})

test('console errors outrank accessibility; a failing page status outranks both', () => {
	const axe: Array<AppCheckVariantAxe> = [
		{
			viewport: 'desktop',
			colorScheme: 'light',
			violations: [violation('image-alt', 'critical', ['img'])],
		},
	]
	assert.match(
		build({ axe, consoleMessages: ['TypeError: x is undefined'] }).summary,
		/Most important issue: Console error: TypeError: x is undefined\. 1 more issue follows below\./,
	)
	assert.match(
		build({ axe, status: 500 }).summary,
		/Most important issue: The page responded with HTTP 500\./,
	)
})

test('lighthouse scores below target fail, worst gap first', () => {
	const report = build({
		scores: {
			performance: 40,
			accessibility: 70,
			'best-practices': 95,
			seo: 95,
		},
	})
	assert.equal(report.result, 'fail')
	assert.deepEqual(
		report.issues.map((issue) => issue.message),
		[
			'Lighthouse accessibility is 70 (target 90 or more).',
			'Lighthouse performance is 40 (target 50 or more).',
		],
	)
})

test('a Lighthouse error is reported, not thrown', () => {
	const report = build({
		scores: {
			performance: null,
			accessibility: null,
			'best-practices': null,
			seo: null,
		} as never,
		lighthouseError: 'Chrome crashed\nstack',
	})
	assert.equal(report.result, 'fail')
	const markdown = formatAppCheckMarkdown(report)
	assert.match(
		markdown,
		/Lighthouse could not score the page: Chrome crashed\n/,
	)
	assert.match(markdown, /- Performance: not scored/)
})
