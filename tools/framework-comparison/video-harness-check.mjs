#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectCapture, findSyncFrame } from './video-capture.mjs'
import { restoreVideoFixtures } from './video-cleanup.mjs'

const output = mkdtempSync(join(tmpdir(), 'kody-video-harness-check-'))
const directories = ['remix', 'start'].map((name) => join(output, name))
for (let index = 0; index < directories.length; index++) {
	const directory = directories[index]
	mkdirSync(directory)
	const video = join(directory, 'workflow.mp4')
	execFileSync('ffmpeg', [
		'-v',
		'error',
		'-f',
		'lavfi',
		'-i',
		`color=black:s=640x360:r=60:d=${index === 0 ? 0.6 : 0.9}`,
		'-f',
		'lavfi',
		'-i',
		'color=white:s=640x360:r=60:d=0.5',
		'-f',
		'lavfi',
		'-i',
		'testsrc2=s=640x360:r=60:d=2.5',
		'-filter_complex',
		'[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
		'-map',
		'[v]',
		'-c:v',
		'libx264',
		'-preset',
		'ultrafast',
		'-pix_fmt',
		'yuv420p',
		'-fps_mode',
		'passthrough',
		video,
	])
	const capture = inspectCapture(video)
	assert.equal(capture.passes60fps, true)
	const sync = findSyncFrame(video, capture.frameTimestampsSeconds)
	assert.ok(Math.abs(sync.seconds - (index === 0 ? 0.6 : 0.9)) < 0.017)
	writeFileSync(
		join(directory, 'result.json'),
		JSON.stringify({
			synthetic: true,
			capture,
			sync,
			restored: true,
			actions: [{ id: 'test', scheduledMs: 2000 }],
		}),
	)
}
const reportPath = join(directories[0], 'result.json')
const originalReport = readFileSync(reportPath, 'utf8')
for (const issue of ['pageErrors', 'retentionVisible', 'restored']) {
	const report = JSON.parse(originalReport)
	if (issue === 'pageErrors') report.pageErrors = 1
	if (issue === 'retentionVisible') report.actions[0].retentionVisible = false
	if (issue === 'restored') report.restored = false
	writeFileSync(reportPath, JSON.stringify(report))
	const rejected = spawnSync(
		process.execPath,
		[
			'tools/framework-comparison/video-compare.mjs',
			...directories,
			join(output, `must-reject-${issue}.mp4`),
		],
		{ encoding: 'utf8' },
	)
	assert.notEqual(rejected.status, 0, `${issue} must reject composition`)
}
writeFileSync(reportPath, originalReport)
const composed = join(output, 'synthetic-comparison.mp4')
execFileSync(
	process.execPath,
	['tools/framework-comparison/video-compare.mjs', ...directories, composed],
	{ stdio: ['ignore', 'ignore', 'pipe'] },
)
const evidence = JSON.parse(
	readFileSync(composed + '.composition.json', 'utf8'),
)
assert.equal(evidence.output.passes60fps, true)
assert.equal(evidence.output.stream.width, 3200)
assert.equal(evidence.output.stream.height, 964)
assert.deepEqual(evidence.labels, ['Remix', 'Start + Query'])
execFileSync('ffmpeg', [
	'-v',
	'error',
	'-ss',
	'1',
	'-i',
	composed,
	'-frames:v',
	'1',
	join(output, 'labels.png'),
])
const calls = []
const original = {
	displayName: 'Original',
	retention: {
		successOnceDays: 14,
		failedOrNeverRanOnceDays: 30,
		disabledRecurringDays: 30,
	},
}
const cleanup = await restoreVideoFixtures(async (method, path) => {
	calls.push([method, path])
	if (path.includes('profile'))
		throw new Error('Simulated profile endpoint failure')
	return { retention: original.retention }
}, original)
assert.equal(cleanup.profileRestored, false)
assert.equal(cleanup.retentionRestored, true)
assert.ok(
	calls.some(([method, path]) => method === 'POST' && path.includes('jobs')),
)
const mismatch = await restoreVideoFixtures(
	async (_method, path) =>
		path.includes('profile')
			? { displayName: 'wrong' }
			: { retention: original.retention },
	original,
)
assert.equal(mismatch.profileRestored, false)
assert.equal(mismatch.retentionRestored, true)
const success = await restoreVideoFixtures(
	async (_method, path) =>
		path.includes('profile')
			? { displayName: original.displayName }
			: { retention: original.retention },
	original,
)
assert.equal(success.profileRestored && success.retentionRestored, true)
writeFileSync(
	join(output, 'checks.json'),
	JSON.stringify(
		{
			synthetic: true,
			cadence: evidence.output.measuredFps,
			dimensions: [evidence.output.stream.width, evidence.output.stream.height],
			sync: evidence.sync,
			cleanupFailureIsolation: cleanup,
			cleanupReadbackMismatch: mismatch,
			cleanupSuccess: success,
		},
		null,
		2,
	),
)
console.log(output)
