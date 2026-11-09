import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
	reportMacosMain,
	trackingIssueTitle,
	type Gh,
} from './macos-main-report.ts'
import type { Needs } from './validate-gate-verdict.ts'

function fakeGh(openIssues: Array<{ number: number; title: string }> = []) {
	const calls: Array<Array<string>> = []
	const gh: Gh = (args) => {
		calls.push(args)
		return args[1] === 'list' ? JSON.stringify(openIssues) : ''
	}
	return { gh, calls }
}

function needs(primary: string, fallback = 'skipped', skip = 'false'): Needs {
	return {
		tested_tree: { result: 'success', outputs: { skip } },
		host_commands_macos: { result: primary },
		host_commands_macos_fallback: { result: fallback },
	}
}

const tracking = { number: 7, title: trackingIssueTitle }

function report(input: Needs, gh: Gh) {
	return reportMacosMain({ needs: input, sha: 'abc', runUrl: 'run', gh })
}

test('a failure opens the tracking issue, or comments when it is open', () => {
	const fresh = fakeGh()
	expect(report(needs('failure'), fresh.gh).action).toBe('created')
	expect(fresh.calls.at(-1)?.slice(0, 4)).toEqual([
		'issue',
		'create',
		'--title',
		trackingIssueTitle,
	])

	const open = fakeGh([tracking])
	expect(report(needs('abandoned', 'failure'), open.gh).action).toBe(
		'commented',
	)
	expect(open.calls.at(-1)?.slice(0, 3)).toEqual(['issue', 'comment', '7'])
})

test('a pass, Intel recovery, or reused PR tree closes the open issue', () => {
	for (const input of [
		needs('success'),
		needs('abandoned', 'success'),
		needs('skipped', 'skipped', 'true'),
	]) {
		const open = fakeGh([tracking])
		expect(report(input, open.gh)).toMatchObject({
			action: 'closed',
			result: { verdict: 'pass' },
		})
		expect(open.calls.at(-1)).toEqual([
			'issue',
			'close',
			'7',
			'--reason',
			'completed',
		])
	}
	const none = fakeGh()
	expect(report(needs('success'), none.gh).action).toBe('none')
})

test('no runner on either pool leaves the issue alone', () => {
	const open = fakeGh([tracking])
	expect(report(needs('abandoned', 'abandoned'), open.gh)).toMatchObject({
		action: 'none',
		result: { verdict: 'infra' },
	})
	expect(open.calls).toEqual([])
})

test('ignores open issues with a different title', () => {
	const other = fakeGh([{ number: 9, title: `${trackingIssueTitle} (old)` }])
	expect(report(needs('failure'), other.gh).action).toBe('created')
})

test('macos-main.yml runs the macOS suite on main outside the deploy gate', () => {
	const workflow = readFileSync(
		new URL('../../.github/workflows/macos-main.yml', import.meta.url),
		'utf8',
	)
	const deploy = readFileSync(
		new URL('../../.github/workflows/deploy.yml', import.meta.url),
		'utf8',
	)
	expect(workflow).toMatch(/on:\n {2}push:\n {4}branches:\n {6}- main/)
	expect(workflow).toContain('runs-on: macos-15\n')
	expect(workflow).toContain('runs-on: macos-15-intel')
	expect(workflow.replace(/\s+/g, ' ')).toContain(
		"needs.host_commands_macos.result == 'abandoned'",
	)
	expect(workflow).toContain('uses: ./.github/actions/host-commands')
	expect(workflow).toContain('run: node tools/ci/tested-tree.ts lookup')
	expect(workflow).toContain('run: node tools/ci/macos-main-report.ts')
	const name = workflow.match(/^name: (.+)$/m)?.[1]
	expect(name).toBeTruthy()
	expect(deploy).not.toContain(name)
	expect(deploy).toMatch(/workflows:\n\s+- '✅ Validate'\n/)
})
