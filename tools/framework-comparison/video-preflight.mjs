#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { startCapture } from './video-capture.mjs'
import { writeFileSync } from 'node:fs'
const output = process.argv[2]
if (!output)
	throw new Error('Usage: video-preflight.mjs /private/tmp/fresh-capture.mp4')
const browser = await chromium.launch({
	headless: false,
	executablePath:
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	args: ['--start-fullscreen'],
	handleSIGINT: false,
})
let capture
try {
	const page = await browser.newPage({ viewport: null })
	await page.setContent(
		'<html><body style="margin:0;background:#111;color:white;font:48px monospace"><canvas></canvas><script>const c=document.querySelector("canvas");c.width=innerWidth;c.height=innerHeight;const ctx=c.getContext("2d");let n=0;function frame(t){ctx.fillStyle="#111";ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle="#fff";ctx.fillText("Capture check "+(++n)+" "+t.toFixed(1),60,100);ctx.fillRect((n*9)%c.width,150,30,100);requestAnimationFrame(frame)}requestAnimationFrame(frame)</script></body></html>',
	)
	await page.bringToFront()
	await new Promise((done) => setTimeout(done, 2000))
	const geometry = await page.evaluate(() => ({
		x: screenX,
		y: screenY,
		width: innerWidth,
		height: innerHeight,
		outerHeight,
		dpr: devicePixelRatio,
	}))
	const { x, y, width, height, outerHeight, dpr } = geometry
	const crop = [
		width * dpr,
		height * dpr,
		x * dpr,
		(y + outerHeight - height) * dpr,
	]
		.map((value) => Math.floor(value / 2) * 2)
		.join(':')
	writeFileSync(
		output + '.geometry.json',
		JSON.stringify({ geometry, crop }, null, 2),
	)
	capture = await startCapture({
		output,
		device: process.env.CAPTURE_DEVICE ?? '4',
		crop,
	})
	await new Promise((done) => setTimeout(done, 5000))
	const evidence = await capture.stop()
	capture = null
	console.log(
		JSON.stringify({
			geometry,
			crop,
			...evidence,
			frameTimestampsSeconds: undefined,
		}),
	)
	if (!evidence.passes60fps) process.exitCode = 1
} finally {
	if (capture) await capture.stop()
	await browser.close()
}
