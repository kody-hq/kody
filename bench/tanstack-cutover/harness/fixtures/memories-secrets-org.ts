// Identical fixture module run on every variant through control-kody execute.
import { kody } from 'kody:runtime'

const topics = [
	['Preferred editor', 'Uses VS Code with Vim keybindings and oxfmt on save.'],
	['Deploy window', 'Prefers deploys between 9am and 3pm Mountain time on weekdays.'],
	['Coffee order', 'Oat milk cortado, no sugar.'],
	['Testing style', 'Writes integration tests first, avoids implementation details.'],
	['Package naming', 'Kody packages use kebab-case leaf names under @user-me.'],
	['Time zone', 'Lives in America/Denver.'],
	['Email triage', 'Archive newsletters after reading, flag invoices.'],
	['Calendar rules', 'No meetings before 10am on Mondays.'],
	['Blog cadence', 'Publishes one technical post every two weeks.'],
	['Preferred stack', 'TypeScript, React, Cloudflare Workers, D1.'],
	['Code review', 'Prefers small PRs with a visual recap.'],
	['Travel', 'Prefers aisle seats and carry-on only.'],
	['Kids schedule', 'School pickup at 3:15pm on weekdays.'],
	['Workshop prep', 'Workshops ship with exercises and solutions branches.'],
	['Music', 'Listens to lo-fi while coding.'],
]

export default async function main() {
	const memories = []
	for (const [subject, summary] of topics) {
		await kody.metaMemoryVerify({ subject, summary })
		const r = await kody.metaMemoryUpsert({
			subject,
			summary,
			category: 'preference',
			verified_by_agent: true,
			details: `${summary} Recorded as a benchmark fixture so list and detail pages render realistic content. `.repeat(3),
		})
		memories.push(r?.memory?.id ?? r?.memory_id ?? r?.id ?? null)
	}
	const secrets = []
	for (let i = 1; i <= 10; i += 1) {
		const name = `BENCH_SECRET_${i}`
		await kody.secretSet({
			name,
			value: `bench-fixture-value-${i}-${'x'.repeat(24)}`,
			description: `Benchmark fixture secret ${i} for the ${['github', 'stripe', 'slack', 'linear', 'notion'][i % 5]} integration`,
			scope: 'user',
		})
		secrets.push(name)
	}
	let org = null
	try {
		org = await kody.orgCreate({ slug: 'bench-org', display_name: 'Bench Org' })
	} catch (error) {
		org = { error: String(error) }
	}
	return { memories, secrets, org }
}
