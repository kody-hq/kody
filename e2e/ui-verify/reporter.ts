import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
	FullResult,
	Reporter,
	TestCase,
	TestResult,
} from '@playwright/test/reporter'
import { uiVerifyPaths, uiVerifyUpdateCommand } from './paths.ts'

type Entry = {
	title: string
	status: TestResult['status']
	problems: string[]
	images: string[]
}

const ansi = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')

/** The labelled lines of each failed soft assertion, plus what broke. */
export function summarizeFailure(message: string) {
	const out = new Set<string>()
	for (const line of message.replace(ansi, '').split('\n')) {
		const trimmed = line.trim().replace(/^Error: /, '')
		if (/^(axe|keyboard|visual): /.test(trimmed)) out.add(trimmed)
		else if (/^\+\s+"/.test(trimmed) && !/ pixels \(ratio/.test(trimmed))
			out.add(
				`  - ${trimmed.replace(/^\+\s+"|",?$/g, '').replaceAll('\\"', '"')}`,
			)
		else if (/\d+ pixels \(ratio [^)]*\) are different\./.test(trimmed))
			out.add(
				`  ${/\d+ pixels \(ratio [^)]*\) are different\./.exec(trimmed)![0]}`,
			)
		else if (/snapshot doesn't exist/.test(trimmed))
			out.add(
				`  No baseline yet. Create it with \`${uiVerifyUpdateCommand}\` and commit it.`,
			)
	}
	if (out.size) return [...out]
	const first = message
		.replace(ansi, '')
		.split('\n')
		.find((line) => line.trim())
	return [first?.trim() ?? 'failed']
}

/** Writes the readable report and machine results for `npm run ui:verify`. */
export default class UiVerifyReporter implements Reporter {
	private entries: Entry[] = []

	onTestEnd(test: TestCase, result: TestResult) {
		this.entries.push({
			title: test.title,
			status: result.status,
			problems: result.errors.flatMap((error) =>
				summarizeFailure(error.message ?? String(error.value ?? '')),
			),
			images: result.attachments
				.filter(
					(attachment) =>
						attachment.path && attachment.contentType === 'image/png',
				)
				.map((attachment) => path.relative(process.cwd(), attachment.path!)),
		})
	}

	onEnd(result: FullResult) {
		mkdirSync(uiVerifyPaths.output, { recursive: true })
		const failed = this.entries.filter(
			(entry) => entry.status !== 'passed' && entry.status !== 'skipped',
		)
		const lines = [
			'# UI verify report',
			'',
			`Result: **${failed.length === 0 && result.status === 'passed' ? 'PASS' : 'FAIL'}** (${this.entries.length - failed.length}/${this.entries.length} checks passed)`,
			'',
			`Screenshots (every target, light and dark, desktop and mobile): \`${uiVerifyPaths.screenshots}/\``,
			'',
		]
		if (failed.length) {
			lines.push('## Failures', '')
			for (const entry of failed) {
				lines.push(`### ${entry.title}`, '', ...entry.problems, '')
				if (entry.images.length)
					lines.push(
						'Images (expected, actual, diff):',
						...entry.images.map((image) => `- \`${image}\``),
						'',
					)
			}
			lines.push(
				'## How to fix',
				'',
				'- `axe:` and `keyboard:` lines are real accessibility bugs. Fix the component or page, then rerun.',
				`- \`visual:\` lines mean the page looks different from its committed baseline. Open the diff image. If the change is a regression, fix it. If it is intended, run \`${uiVerifyUpdateCommand}\` and commit the updated files under \`${uiVerifyPaths.baselines}/\` with the change that caused them.`,
				'- A missing baseline (new target or gallery section) is created by the same update command.',
				'',
			)
		}
		lines.push('## Checks', '', '| Check | Result |', '| --- | --- |')
		for (const entry of this.entries)
			lines.push(
				`| ${entry.title} | ${entry.status === 'passed' ? 'pass' : entry.status} |`,
			)
		writeFileSync(uiVerifyPaths.report, `${lines.join('\n')}\n`)
		writeFileSync(
			uiVerifyPaths.results,
			`${JSON.stringify({ status: result.status, checks: this.entries }, null, 2)}\n`,
		)
		console.log(`\nui:verify report: ${uiVerifyPaths.report}`)
	}
}
