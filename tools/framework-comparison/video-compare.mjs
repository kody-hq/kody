#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectCapture } from './video-capture.mjs'
const [leftDirectory, rightDirectory, output] = process.argv.slice(2)
if (!output || existsSync(output))
	throw new Error('Usage: video-compare.mjs REMIX_DIR START_DIR NEW_OUTPUT.mp4')
const reports = [leftDirectory, rightDirectory].map((directory) =>
	JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')),
)
if (
	reports.some(
		(report) =>
			report.failure ||
			(report.actions ?? []).some(
				(action) =>
					action.retentionVisible === false || action.newNameVisible === false,
			) ||
			report.pageErrors ||
			!report.capture?.passes60fps ||
			!report.sync ||
			!report.restored,
	)
)
	throw new Error(
		'Both source runs must pass capture, workflow, synchronization, and restoration checks',
	)
if (
	JSON.stringify(
		reports[0].actions.map(({ id, scheduledMs }) => [id, scheduledMs]),
	) !==
	JSON.stringify(
		reports[1].actions.map(({ id, scheduledMs }) => [id, scheduledMs]),
	)
)
	throw new Error('The runs have different action schedules')
const sourcePaths = [leftDirectory, rightDirectory].map((directory) =>
	join(directory, 'workflow.mp4'),
)
const sources = sourcePaths.map(inspectCapture)
if (sources.some((source) => !source.passes60fps))
	throw new Error(
		'Actual source timestamp inspection failed, regardless of saved report',
	)
if (
	sources[0].stream.width !== sources[1].stream.width ||
	sources[0].stream.height !== sources[1].stream.height
)
	throw new Error('Source browser dimensions differ')
const font = '/System/Library/Fonts/Supplemental/Arial.ttf'
if (!existsSync(font)) throw new Error('The declared label font is unavailable')
const labels = ['Remix', 'Start + Query']
const panelWidth =
	Math.round((sources[0].stream.width * 900) / sources[0].stream.height / 2) * 2
const labelPath = output + '.labels.png'
execFileSync(
	'swift',
	[
		'tools/framework-comparison/video-labels.swift',
		font,
		String(panelWidth),
		labelPath,
	],
	{ stdio: ['ignore', 'ignore', 'pipe'] },
)
const filter =
	reports
		.map(
			(report, index) =>
				`[${index}:v]trim=start=${report.sync.seconds},setpts=PTS-STARTPTS,scale=-2:900,setsar=1,pad=iw:ih+64:0:64:color=0x111111[v${index}]`,
		)
		.join(';') +
	';[v0][v1]hstack=inputs=2:shortest=1[stack];[stack][2:v]overlay=0:0:shortest=1,fps=fps=60:round=near[v]'
const args = [
	'-hide_banner',
	'-i',
	sourcePaths[0],
	'-i',
	sourcePaths[1],
	'-loop',
	'1',
	'-framerate',
	'60',
	'-i',
	labelPath,
	'-filter_complex',
	filter,
	'-map',
	'[v]',
	'-an',
	'-c:v',
	'libx264',
	'-preset',
	'fast',
	'-crf',
	'18',
	'-pix_fmt',
	'yuv420p',
	'-fps_mode',
	'passthrough',
	'-movflags',
	'+faststart',
	output,
]
execFileSync('ffmpeg', args, { stdio: 'inherit' })
const evidence = inspectCapture(output)
writeFileSync(
	output + '.composition.json',
	JSON.stringify(
		{
			labels,
			font,
			args,
			sourcePaths,
			sourceCadence: sources.map(
				({ frameTimestampsSeconds: _frames, ...source }) => source,
			),
			sync: reports.map((report) => report.sync),
			timing:
				'Real playback speed. Native sources are independently checked at 60 fps. hstack and the explicit 60 fps output grid may repeat or drop the nearest source frame while aligning independent capture timestamps. No motion interpolation or time scaling.',
			output: evidence,
		},
		null,
		2,
	),
)
if (!evidence.passes60fps)
	throw new Error('Composed output did not pass the 60 fps timestamp check')
