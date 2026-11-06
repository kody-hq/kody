const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const {
	trayIconFileName,
	trayIconPath,
	createTrayIcon,
} = require('../tray-icon.cjs')

const assets = join(__dirname, '../assets')
const publicDir = join(__dirname, '../../worker/public')

test('tray icon file names follow light/dark chrome', () => {
	assert.equal(trayIconFileName(false), 'tray-light.png')
	assert.equal(trayIconFileName(true), 'tray-dark.png')
})

test('tray icon paths resolve under desktop assets', () => {
	assert.equal(
		trayIconPath(false, join(__dirname, '..')),
		join(assets, 'tray-light.png'),
	)
	assert.equal(
		trayIconPath(true, join(__dirname, '..')),
		join(assets, 'tray-dark.png'),
	)
})

test('tray assets match published favicon light/dark treatments', () => {
	const pairs = [
		['tray-light.png', 'favicon-16x16.png'],
		['tray-light@2x.png', 'favicon-32x32.png'],
		['tray-dark.png', 'favicon-16x16-dark.png'],
		['tray-dark@2x.png', 'favicon-32x32-dark.png'],
	]
	for (const [tray, favicon] of pairs) {
		const trayPath = join(assets, tray)
		const faviconPath = join(publicDir, favicon)
		assert.equal(existsSync(trayPath), true, tray)
		assert.equal(existsSync(faviconPath), true, favicon)
		assert.equal(
			createHash('sha256').update(readFileSync(trayPath)).digest('hex'),
			createHash('sha256').update(readFileSync(faviconPath)).digest('hex'),
			`${tray} must stay identical to ${favicon}`,
		)
	}
})

test('createTrayIcon reads the theme-appropriate asset', () => {
	const paths = []
	const nativeImage = {
		createFromPath: (path) => {
			paths.push(path)
			return { path }
		},
	}
	assert.deepEqual(
		createTrayIcon(
			nativeImage,
			{ shouldUseDarkColors: false },
			{
				root: join(__dirname, '..'),
			},
		),
		{ path: join(assets, 'tray-light.png') },
	)
	assert.deepEqual(
		createTrayIcon(
			nativeImage,
			{ shouldUseDarkColors: true },
			{
				root: join(__dirname, '..'),
			},
		),
		{ path: join(assets, 'tray-dark.png') },
	)
	assert.deepEqual(
		createTrayIcon(
			nativeImage,
			{ shouldUseDarkColors: true },
			{
				root: join(__dirname, '..'),
				dark: false,
			},
		),
		{ path: join(assets, 'tray-light.png') },
	)
	assert.deepEqual(paths, [
		join(assets, 'tray-light.png'),
		join(assets, 'tray-dark.png'),
		join(assets, 'tray-light.png'),
	])
})
