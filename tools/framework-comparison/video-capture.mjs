import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, writeFileSync } from 'node:fs'

// Preserve acquisition timestamps. Never use -r or an fps filter to manufacture 60 fps.
export async function startCapture({ output, device, crop }) {
	if (existsSync(output)) throw new Error('Capture output already exists')
	if (!/^\d+$/.test(String(device)))
		throw new Error('Use an enumerated screen device number')
	if (crop && !/^\d+:\d+:\d+:\d+$/.test(crop))
		throw new Error('crop must be width:height:x:y in physical pixels')
	const args = [
		'-hide_banner',
		'-nostdin',
		'-f',
		'avfoundation',
		'-framerate',
		'60',
		'-capture_cursor',
		'1',
		'-i',
		`${device}:none`,
	]
	if (crop) args.push('-vf', `crop=${crop}`)
	args.push(
		'-an',
		'-c:v',
		'libx264',
		'-preset',
		'ultrafast',
		'-crf',
		'18',
		'-pix_fmt',
		'yuv420p',
		'-fps_mode',
		'passthrough',
		'-movflags',
		'+faststart',
		output,
	)
	const log = createWriteStream(output + '.capture.log', { flags: 'wx' })
	const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
	let error
	proc.on('error', (value) => {
		error = value
	})
	proc.stderr.pipe(log)
	const completion = new Promise((resolve) =>
		proc.on('close', (code) => resolve(code)),
	)
	await new Promise((resolve) => setTimeout(resolve, 2000))
	if (error || proc.exitCode !== null)
		throw error ?? new Error('Screen capture failed, inspect capture log')
	const startedAt = new Date().toISOString()
	return {
		startedAt,
		async stop() {
			proc.kill('SIGINT')
			await completion
			await new Promise((resolve) => log.end(resolve))
			const evidence = inspectCapture(output)
			writeFileSync(
				output + '.capture.json',
				JSON.stringify(
					{
						acquisition: 'AVFoundation screen input requested at 60 fps',
						args,
						startedAt,
						...evidence,
					},
					null,
					2,
				),
			)
			return evidence
		},
	}
}

export function inspectCapture(output) {
	const probe = JSON.parse(
		execFileSync(
			'ffprobe',
			[
				'-v',
				'error',
				'-select_streams',
				'v:0',
				'-show_streams',
				'-show_frames',
				'-show_entries',
				'frame=best_effort_timestamp_time:stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration',
				'-of',
				'json',
				output,
			],
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
		),
	)
	const times = probe.frames.map((frame) =>
		Number(frame.best_effort_timestamp_time),
	)
	const deltas = times
		.slice(1)
		.map((time, index) => (time - times[index]) * 1000)
	const sorted = [...deltas].sort((a, b) => a - b)
	const measuredFps = (times.length - 1) / (times.at(-1) - times[0])
	return {
		stream: probe.streams[0],
		frames: times.length,
		measuredFps,
		medianFrameIntervalMs: sorted[Math.floor(sorted.length / 2)],
		p95FrameIntervalMs: sorted[Math.floor(sorted.length * 0.95)],
		maxFrameIntervalMs: sorted.at(-1),
		intervalsOver25ms: deltas.filter((value) => value > 25).length,
		// This is deliberately stricter than a container claiming 60/1.
		passes60fps:
			measuredFps >= 59 &&
			measuredFps <= 61 &&
			deltas.every((value) => value > 0) &&
			deltas.filter((value) => value > 25).length / deltas.length < 0.01,
		frameTimestampsSeconds: times,
	}
}

export function findSyncFrame(output, frameTimestampsSeconds) {
	const pixels = execFileSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			output,
			'-t',
			'5',
			'-vf',
			'scale=1:1,format=gray',
			'-fps_mode',
			'passthrough',
			'-f',
			'rawvideo',
			'-',
		],
		{ maxBuffer: 1024 * 1024 },
	)
	const index = pixels.findIndex((value) => value > 245)
	if (index < 0)
		throw new Error(
			'No white synchronization slate found in first five seconds',
		)
	return { index, seconds: frameTimestampsSeconds[index] }
}
