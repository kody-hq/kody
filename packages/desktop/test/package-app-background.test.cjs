const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
	linuxAutostartEntry,
	popoverBounds,
	popoverSize,
	validAccelerator,
} = require('../package-app-background.cjs')

test('global shortcuts need a modifier and one known key', () => {
	assert.equal(validAccelerator('CmdOrCtrl+Shift+K'), 'CmdOrCtrl+Shift+K')
	assert.equal(validAccelerator('Alt+F12'), 'Alt+F12')
	for (const bad of [
		'K',
		'Shift+Shift+K',
		'Ctrl+K+J',
		'Ctrl+Bogus',
		'Ctrl+',
		7,
		'',
	])
		assert.equal(validAccelerator(bad), null, String(bad))
})

test('menu-bar popovers size from the meta tag and stay on screen', () => {
	assert.deepEqual(popoverSize('320x240'), { width: 320, height: 240 })
	assert.deepEqual(popoverSize('5000 x 10'), { width: 800, height: 120 })
	assert.deepEqual(popoverSize('wide'), { width: 360, height: 480 })
	const workArea = { x: 0, y: 24, width: 1000, height: 700 }
	const size = { width: 300, height: 200 }
	assert.deepEqual(
		popoverBounds({ x: 980, y: 0, width: 20, height: 24 }, size, workArea),
		{
			x: 700,
			y: 24,
			...size,
		},
	)
	assert.deepEqual(
		popoverBounds({ x: 10, y: 700, width: 20, height: 24 }, size, workArea),
		{
			x: 0,
			y: 500,
			...size,
		},
	)
})

test('the Linux autostart entry starts Kody hidden', () => {
	const entry = linuxAutostartEntry('/opt/Kody "x"/kody')
	assert.match(entry, /^Exec="\/opt\/Kody \\"x\\"\/kody" --kody-start-hidden$/m)
})
