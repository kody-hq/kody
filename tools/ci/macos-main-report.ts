import { spawnSync } from 'node:child_process'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	classifyMacosNeeds,
	type JobVerdict,
	type Needs,
} from './validate-gate-verdict.ts'

/**
 * Reports `.github/workflows/macos-main.yml`, the macOS host-command run on
 * main that sits outside the deploy gate. A failure opens (or comments on) one
 * tracking issue and fails the run; a pass closes it. No runner on either
 * macOS pool leaves the issue alone: nothing ran.
 *
 *   NEEDS='${{ toJSON(needs) }}' RUN_URL=... node tools/ci/macos-main-report.ts
 */

export const trackingIssueTitle = 'main: macOS host commands failing'

export type Gh = (args: Array<string>) => string

export function macosMainVerdict(needs: Needs): JobVerdict {
	if (needs.tested_tree?.outputs?.skip === 'true') {
		return {
			job: 'host_commands_macos',
			verdict: 'pass',
			detail: 'same tree passed PR Validate, macOS included',
		}
	}
	return classifyMacosNeeds(needs)
}

function findOpenIssue(gh: Gh) {
	const issues = JSON.parse(
		gh([
			'issue',
			'list',
			'--search',
			`in:title "${trackingIssueTitle}"`,
			'--state',
			'open',
			'--json',
			'number,title',
		]),
	) as Array<{ number: number; title: string }>
	return issues.find((issue) => issue.title === trackingIssueTitle) ?? null
}

export function reportMacosMain(input: {
	needs: Needs
	sha: string
	runUrl: string
	gh: Gh
}) {
	const result = macosMainVerdict(input.needs)
	const line = `\`${input.sha}\`: ${result.detail} ([run](${input.runUrl}))`
	if (result.verdict === 'infra') return { result, action: 'none' as const }
	const existing = findOpenIssue(input.gh)
	if (result.verdict === 'pass') {
		if (!existing) return { result, action: 'none' as const }
		input.gh([
			'issue',
			'comment',
			String(existing.number),
			'--body',
			`macOS host commands pass again on main. ${line}`,
		])
		input.gh([
			'issue',
			'close',
			String(existing.number),
			'--reason',
			'completed',
		])
		return { result, action: 'closed' as const, number: existing.number }
	}
	const body = `macOS host commands failed on main. ${line}\n\nThis job does not gate Deploy, so the commit may already be live. PR Validate runs the same suite (\`.github/actions/host-commands\`).`
	if (existing) {
		input.gh(['issue', 'comment', String(existing.number), '--body', body])
		return { result, action: 'commented' as const, number: existing.number }
	}
	input.gh(['issue', 'create', '--title', trackingIssueTitle, '--body', body])
	return { result, action: 'created' as const }
}

function gh(args: Array<string>) {
	const run = spawnSync('gh', args, { encoding: 'utf8' })
	if (run.status !== 0) {
		throw new Error(run.stderr || `gh ${args.join(' ')} failed`)
	}
	return run.stdout
}

if (isExecutedDirectly(import.meta.url)) {
	const { result, action } = reportMacosMain({
		needs: JSON.parse(process.env.NEEDS ?? '{}') as Needs,
		sha: process.env.GITHUB_SHA ?? 'unknown',
		runUrl: process.env.RUN_URL ?? '',
		gh,
	})
	if (result.verdict === 'infra') {
		console.log(
			`::warning title=CI infrastructure, not a code failure::${result.detail}. macOS was not checked for this commit.`,
		)
	} else if (result.verdict === 'fail') {
		console.log(
			`::error title=macOS host commands failed on main::${result.detail}`,
		)
	}
	console.log(`${result.verdict} (${result.detail}); issue: ${action}`)
	process.exitCode = result.verdict === 'fail' ? 1 : 0
}
