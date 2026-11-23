/**
 * The `kody app check` report: a short `app-check.md` for an agent's context
 * window and an uncapped `app-check.json` sidecar for programmatic use. The
 * result is pass or fail in the report; the command still exits 0 for it.
 */

export type AppCheckViewport = 'desktop' | 'mobile'
export type AppCheckColorScheme = 'light' | 'dark'
export type AxeImpact = 'critical' | 'serious' | 'moderate' | 'minor'

export type AppCheckScreenshot = {
	viewport: AppCheckViewport
	colorScheme: AppCheckColorScheme
	path: string
	status: number | null
}

export type AxeNode = {
	target: Array<string>
	html: string
	failureSummary: string
}

/** One axe rule result from one rendered variant. */
export type AxeViolation = {
	id: string
	impact: AxeImpact | null
	help: string
	helpUrl: string
	description: string
	nodes: Array<AxeNode>
}

export type AppCheckVariantAxe = {
	viewport: AppCheckViewport
	colorScheme: AppCheckColorScheme
	violations: Array<AxeViolation>
	error?: string
}

/** A rule merged across the four variants it was checked in. */
export type AppCheckAccessibilityRule = {
	id: string
	impact: AxeImpact
	help: string
	helpUrl: string
	selectors: Array<string>
	variants: Array<`${AppCheckViewport}-${AppCheckColorScheme}`>
}

export type LighthouseCategory =
	| 'performance'
	| 'accessibility'
	| 'best-practices'
	| 'seo'

export const lighthouseCategories: ReadonlyArray<LighthouseCategory> = [
	'performance',
	'accessibility',
	'best-practices',
	'seo',
]

/** Lowest passing score (0 to 100). Performance is lower: the preview is a dev build. */
export const lighthouseThresholds: Record<LighthouseCategory, number> = {
	performance: 50,
	accessibility: 90,
	'best-practices': 90,
	seo: 90,
}

export type AppCheckLighthouse = {
	scores: Record<LighthouseCategory, number | null>
	error?: string
}

export type AppCheckConsoleSource = 'browser' | 'page' | 'server'

export type AppCheckConsoleEntry = {
	source: AppCheckConsoleSource
	message: string
	viewport?: AppCheckViewport
	colorScheme?: AppCheckColorScheme
	url?: string
}

export type AppCheckConsoleError = {
	message: string
	sources: Array<AppCheckConsoleSource>
	count: number
}

export type AppCheckIssue = {
	kind: 'page_status' | 'console' | 'accessibility' | 'lighthouse'
	message: string
}

export type AppCheckReport = {
	version: 1
	result: 'pass' | 'fail'
	summary: string
	package: { name: string; root: string }
	url: string
	target: string
	checkedAt: string
	outputDir: string
	issues: Array<AppCheckIssue>
	screenshots: Array<AppCheckScreenshot>
	accessibility: {
		rules: Array<AppCheckAccessibilityRule>
		variants: Array<AppCheckVariantAxe>
	}
	lighthouse: AppCheckLighthouse & {
		thresholds: Record<LighthouseCategory, number>
	}
	console: {
		errors: Array<AppCheckConsoleError>
		entries: Array<AppCheckConsoleEntry>
	}
}

const impactRank: Record<AxeImpact, number> = {
	critical: 0,
	serious: 1,
	moderate: 2,
	minor: 3,
}

const markdownListLimit = 10
const markdownSelectorLimit = 3

/** Merge per-variant axe results by rule, most severe first. */
export function mergeAccessibilityRules(
	variants: ReadonlyArray<AppCheckVariantAxe>,
): Array<AppCheckAccessibilityRule> {
	const byId = new Map<string, AppCheckAccessibilityRule>()
	for (const variant of variants) {
		const variantKey = `${variant.viewport}-${variant.colorScheme}` as const
		for (const violation of variant.violations) {
			const impact = violation.impact ?? 'minor'
			const existing = byId.get(violation.id)
			const rule = existing ?? {
				id: violation.id,
				impact,
				help: violation.help,
				helpUrl: violation.helpUrl,
				selectors: [],
				variants: [],
			}
			if (impactRank[impact] < impactRank[rule.impact]) rule.impact = impact
			if (!rule.variants.includes(variantKey)) rule.variants.push(variantKey)
			for (const node of violation.nodes) {
				const selector = node.target.join(' ')
				if (!rule.selectors.includes(selector)) rule.selectors.push(selector)
			}
			byId.set(violation.id, rule)
		}
	}
	return [...byId.values()].sort(
		(a, b) =>
			impactRank[a.impact] - impactRank[b.impact] ||
			b.selectors.length - a.selectors.length ||
			a.id.localeCompare(b.id),
	)
}

/** Deduplicate console errors by message, most frequent first. */
export function dedupeConsoleErrors(
	entries: ReadonlyArray<AppCheckConsoleEntry>,
): Array<AppCheckConsoleError> {
	const byMessage = new Map<string, AppCheckConsoleError>()
	for (const entry of entries) {
		const message = entry.message.trim()
		if (!message) continue
		const existing = byMessage.get(message)
		if (existing) {
			existing.count += 1
			if (!existing.sources.includes(entry.source))
				existing.sources.push(entry.source)
			continue
		}
		byMessage.set(message, { message, sources: [entry.source], count: 1 })
	}
	return [...byMessage.values()].sort((a, b) => b.count - a.count)
}

function categoryLabel(category: LighthouseCategory): string {
	switch (category) {
		case 'performance':
			return 'Performance'
		case 'accessibility':
			return 'Accessibility'
		case 'best-practices':
			return 'Best practices'
		case 'seo':
			return 'SEO'
	}
}

function firstLine(text: string): string {
	return text.split('\n')[0]?.trim() ?? ''
}

function sentence(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`
}

/** Failing issues, most important first. */
export function collectIssues(input: {
	screenshots: ReadonlyArray<AppCheckScreenshot>
	rules: ReadonlyArray<AppCheckAccessibilityRule>
	lighthouse: AppCheckLighthouse
	consoleErrors: ReadonlyArray<AppCheckConsoleError>
}): Array<AppCheckIssue> {
	const issues: Array<AppCheckIssue> = []
	const badStatus = input.screenshots.find(
		(shot) => shot.status !== null && shot.status >= 400,
	)
	if (badStatus) {
		issues.push({
			kind: 'page_status',
			message: `The page responded with HTTP ${badStatus.status}. Fix the app so its root route renders.`,
		})
	}
	for (const error of input.consoleErrors) {
		issues.push({
			kind: 'console',
			message: `Console error: ${sentence(firstLine(error.message))}`,
		})
	}
	for (const rule of input.rules) {
		if (rule.impact !== 'critical' && rule.impact !== 'serious') continue
		issues.push({
			kind: 'accessibility',
			message: `Accessibility (${rule.impact}) ${rule.id}: ${rule.help} (${rule.selectors[0] ?? 'page'}).`,
		})
	}
	if (input.lighthouse.error) {
		issues.push({
			kind: 'lighthouse',
			message: `Lighthouse could not score the page: ${sentence(firstLine(input.lighthouse.error))}`,
		})
	}
	const belowThreshold = lighthouseCategories
		.map((category) => ({
			category,
			score: input.lighthouse.scores[category],
		}))
		.filter(
			(entry): entry is { category: LighthouseCategory; score: number } =>
				entry.score !== null &&
				entry.score < lighthouseThresholds[entry.category],
		)
		.sort(
			(a, b) =>
				a.score -
				lighthouseThresholds[a.category] -
				(b.score - lighthouseThresholds[b.category]),
		)
	for (const { category, score } of belowThreshold) {
		issues.push({
			kind: 'lighthouse',
			message: `Lighthouse ${categoryLabel(category).toLowerCase()} is ${score} (target ${lighthouseThresholds[category]} or more).`,
		})
	}
	return issues
}

export function summarize(input: {
	issues: ReadonlyArray<AppCheckIssue>
	rules: ReadonlyArray<AppCheckAccessibilityRule>
}): string {
	const [top, ...rest] = input.issues
	if (top) {
		const more =
			rest.length > 0
				? ` ${rest.length === 1 ? '1 more issue follows' : `${rest.length} more issues follow`} below.`
				: ''
		return `Result: FAIL. Most important issue: ${top.message}${more} Fix the issues, then run \`kody app check\` again.`
	}
	const minor = input.rules[0]
	return minor
		? `Result: PASS. No console errors, no critical or serious accessibility violations, and Lighthouse scores meet their targets. Worth fixing next: ${minor.id} (${minor.impact}): ${minor.help}.`
		: 'Result: PASS. No console errors, no accessibility violations, and Lighthouse scores meet their targets.'
}

export function buildAppCheckReport(input: {
	package: { name: string; root: string }
	url: string
	target: string
	checkedAt: string
	outputDir: string
	screenshots: Array<AppCheckScreenshot>
	axe: Array<AppCheckVariantAxe>
	lighthouse: AppCheckLighthouse
	consoleEntries: Array<AppCheckConsoleEntry>
}): AppCheckReport {
	const rules = mergeAccessibilityRules(input.axe)
	const consoleErrors = dedupeConsoleErrors(input.consoleEntries)
	const issues = collectIssues({
		screenshots: input.screenshots,
		rules,
		lighthouse: input.lighthouse,
		consoleErrors,
	})
	for (const variant of input.axe) {
		if (!variant.error) continue
		issues.push({
			kind: 'accessibility',
			message: `axe could not check ${variant.viewport} ${variant.colorScheme}: ${sentence(firstLine(variant.error))}`,
		})
	}
	return {
		version: 1,
		result: issues.length === 0 ? 'pass' : 'fail',
		summary: summarize({ issues, rules }),
		package: input.package,
		url: input.url,
		target: input.target,
		checkedAt: input.checkedAt,
		outputDir: input.outputDir,
		issues,
		screenshots: input.screenshots,
		accessibility: { rules, variants: input.axe },
		lighthouse: { ...input.lighthouse, thresholds: lighthouseThresholds },
		console: { errors: consoleErrors, entries: input.consoleEntries },
	}
}

function inlineCode(text: string): string {
	const clean = text.replace(/\s+/g, ' ').trim()
	const fence = clean.includes('`') ? '``' : '`'
	return `${fence}${clean}${fence}`
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function remainder(count: number, noun: string): Array<string> {
	return count > 0 ? ['', `And ${count} more ${noun} in app-check.json.`] : []
}

/** `app-check.md`: capped lists so it fits an agent's context window. */
export function formatAppCheckMarkdown(report: AppCheckReport): string {
	const lines: Array<string> = [
		`# kody app check: ${report.package.name}`,
		'',
		report.summary,
		'',
		`Checked ${report.url} (target ${report.target}) at ${report.checkedAt}.`,
		'',
		'## Screenshots',
		'',
	]
	for (const shot of report.screenshots) {
		lines.push(`- ${shot.viewport} ${shot.colorScheme}: ${shot.path}`)
	}

	lines.push('', '## Accessibility violations', '')
	const rules = report.accessibility.rules
	if (rules.length === 0) {
		lines.push('None found.')
	} else {
		for (const rule of rules.slice(0, markdownListLimit)) {
			const selectors = rule.selectors
				.slice(0, markdownSelectorLimit)
				.map((selector) => inlineCode(truncate(selector, 120)))
				.join(', ')
			const extraSelectors = rule.selectors.length - markdownSelectorLimit
			lines.push(
				`- **${rule.impact}** ${rule.id}: ${rule.help}. Selectors: ${selectors}${extraSelectors > 0 ? ` and ${extraSelectors} more` : ''}. ${rule.helpUrl}`,
			)
		}
		lines.push(
			...remainder(
				rules.length - markdownListLimit,
				rules.length - markdownListLimit === 1 ? 'rule' : 'rules',
			),
		)
	}
	const axeErrors = report.accessibility.variants.filter(
		(variant) => variant.error,
	)
	for (const variant of axeErrors) {
		lines.push(
			'',
			`axe could not check ${variant.viewport} ${variant.colorScheme}: ${firstLine(variant.error ?? '')}`,
		)
	}

	lines.push('', '## Lighthouse scores', '')
	if (report.lighthouse.error) {
		lines.push(
			`Lighthouse could not score the page: ${firstLine(report.lighthouse.error)}`,
			'',
		)
	}
	for (const category of lighthouseCategories) {
		const score = report.lighthouse.scores[category]
		lines.push(
			`- ${categoryLabel(category)}: ${score ?? 'not scored'} (target ${lighthouseThresholds[category]})`,
		)
	}

	lines.push('', '## Console errors', '')
	const errors = report.console.errors
	if (errors.length === 0) {
		lines.push('None.')
	} else {
		for (const error of errors.slice(0, markdownListLimit)) {
			lines.push(
				`- ${inlineCode(truncate(firstLine(error.message), 300))}${error.count > 1 ? ` (${error.count} times)` : ''}`,
			)
		}
		lines.push(
			...remainder(
				errors.length - markdownListLimit,
				errors.length - markdownListLimit === 1 ? 'error' : 'errors',
			),
		)
	}
	lines.push('')
	return lines.join('\n')
}
