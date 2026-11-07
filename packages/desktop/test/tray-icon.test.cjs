const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { trayChromeIsDark, createTrayIcon } = require('../tray-icon.cjs')

const assets = join(__dirname, '../assets')
const publicDir = join(__dirname, '../../worker/public')

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

test('macOS tray chrome prefers system-integrated UI over app theme', () => {
	assert.equal(
		trayChromeIsDark(
			{
				shouldUseDarkColors: false,
				shouldUseDarkColorsForSystemIntegratedUI: true,
			},
			{ platform: 'darwin' },
		),
		true,
	)
	assert.equal(
		trayChromeIsDark(
			{
				shouldUseDarkColors: true,
				shouldUseDarkColorsForSystemIntegratedUI: false,
			},
			{ platform: 'darwin' },
		),
		false,
	)
	assert.equal(
		trayChromeIsDark({ shouldUseDarkColors: true }, { platform: 'darwin' }),
		true,
	)
})

test('Windows tray chrome uses live shouldUseDarkColors (Electron #52308)', () => {
	assert.equal(
		trayChromeIsDark(
			{
				shouldUseDarkColors: true,
				shouldUseDarkColorsForSystemIntegratedUI: false,
			},
			{ platform: 'win32' },
		),
		true,
	)
	assert.equal(
		trayChromeIsDark(
			{
				shouldUseDarkColors: false,
				shouldUseDarkColorsForSystemIntegratedUI: true,
			},
			{ platform: 'win32' },
		),
		false,
	)
})

test('createTrayIcon reads the chrome-appropriate asset', () => {
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
			{
				shouldUseDarkColors: true,
				shouldUseDarkColorsForSystemIntegratedUI: false,
			},
			{
				root: join(__dirname, '..'),
				platform: 'darwin',
			},
		),
		{ path: join(assets, 'tray-light.png') },
	)
	assert.deepEqual(
		createTrayIcon(
			nativeImage,
			{
				shouldUseDarkColors: false,
				shouldUseDarkColorsForSystemIntegratedUI: true,
			},
			{
				root: join(__dirname, '..'),
				platform: 'darwin',
			},
		),
		{ path: join(assets, 'tray-dark.png') },
	)
	assert.deepEqual(
		createTrayIcon(
			nativeImage,
			{
				shouldUseDarkColors: true,
				shouldUseDarkColorsForSystemIntegratedUI: false,
			},
			{
				root: join(__dirname, '..'),
				platform: 'win32',
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
		join(assets, 'tray-dark.png'),
		join(assets, 'tray-light.png'),
	])
})
