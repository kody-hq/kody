import { acquisitionPages } from './catalog.ts'
import type { AcquisitionPage } from './types.ts'

export function acquisitionMarkdown(page: AcquisitionPage): string {
	const lines = [
		`# ${page.title}`,
		'',
		page.lead,
		'',
		'[Connect your agent](/onboarding)',
		'',
	]
	for (const section of page.sections) {
		lines.push(
			`## ${section.title}`,
			'',
			...section.paragraphs.flatMap((text) => [text, '']),
		)
		if (section.table) {
			const { headers, rows } = section.table
			lines.push(
				`| ${headers.join(' | ')} |`,
				`| ${headers.map(() => '---').join(' | ')} |`,
				...rows.map((row) => `| ${row.join(' | ')} |`),
				'',
			)
		}
		if (section.steps)
			lines.push(
				...section.steps.map((step, index) => `${index + 1}. ${step}`),
				'',
			)
		if (section.code) lines.push('```json', section.code, '```', '')
	}
	lines.push(
		'## Try it with your agent',
		'',
		'Connect your agent to Kody, then use this starting prompt. Review the proposed setup and permissions before running it.',
		'',
		page.prompt,
		'',
		'## Documentation',
		'',
	)
	lines.push(
		...page.sources.map((source) => `- [${source.label}](${source.href})`),
		'',
		'## Related workflows',
		'',
	)
	for (const key of page.related) {
		const related = acquisitionPages.find((entry) => entry.key === key)
		if (related) lines.push(`- [${related.title}](${related.path})`)
	}
	return lines.join('\n') + '\n'
}
