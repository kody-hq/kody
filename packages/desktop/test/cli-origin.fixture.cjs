// Smoke tests only: point the bundled CLI at a local origin and an isolated
// config dir (the shell itself always targets production).
const childProcess = require('node:child_process')
const fork = childProcess.fork
const extra = JSON.parse(process.env.KODY_DESKTOP_TEST_CLI_ENV || '{}')
childProcess.fork = (modulePath, args, options = {}) =>
	fork(modulePath, args, { ...options, env: { ...options.env, ...extra } })
