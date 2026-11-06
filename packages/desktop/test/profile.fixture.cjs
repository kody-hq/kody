const { app } = require('electron')
app.setPath('userData', process.env.KODY_DESKTOP_TEST_PROFILE)

const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const presencePath = join(app.getPath('userData'), 'presence.json')
if (!existsSync(presencePath))
	writeFileSync(
		presencePath,
		JSON.stringify({ background: false, chosen: true }),
	)
