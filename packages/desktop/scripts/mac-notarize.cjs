const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const {
	appleDelaysMs,
	classifyFailure,
	defaultRun,
	runWithRetry,
	sleepSync,
} = require('./release-retry.cjs')

// Notarization runs outside electron-builder so a dropped connection after
// Apple accepted the upload resumes the same submission, and a stapling flake
// never re-signs or re-notarizes the app.

function notaryAuth(env = process.env) {
	for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
		if (!env[name]) throw new Error(`Missing release credential: ${name}`)
	return [
		'--key',
		env.APPLE_API_KEY,
		'--key-id',
		env.APPLE_API_KEY_ID,
		'--issuer',
		env.APPLE_API_ISSUER,
	]
}

function parseJson(output) {
	const start = output.indexOf('{')
	const end = output.lastIndexOf('}')
	if (start < 0 || end < start) return null
	try {
		return JSON.parse(output.slice(start, end + 1))
	} catch {
		return null
	}
}

function notarize(appPath, options = {}) {
	const {
		auth = notaryAuth(),
		run,
		sleep = sleepSync,
		log = (line) => process.stderr.write(`${line}\n`),
		now = Date.now,
		deadlineMs = 45 * 60_000,
		waitTimeout = '10m',
		pollDelaysMs = [15_000, 30_000, 60_000],
		delaysMs = appleDelaysMs,
		zipDir,
	} = options
	const retry = { run, sleep, log, delaysMs }
	const workDir = zipDir ?? mkdtempSync(join(tmpdir(), 'kody-notarize-'))
	const zipPath = join(workDir, `${basename(appPath, '.app')}.zip`)
	try {
		runWithRetry(
			'ditto',
			[
				'-c',
				'-k',
				'--sequesterRsrc',
				'--keepParent',
				basename(appPath),
				zipPath,
			],
			{ ...retry, label: 'ditto', spawnOptions: { cwd: dirname(appPath) } },
		)
		// A dropped upload never returned an id, so a retry is a new submission.
		// Once an id exists, only that submission is polled.
		const submitted = runWithRetry(
			'xcrun',
			['notarytool', 'submit', zipPath, ...auth, '--output-format', 'json'],
			{ ...retry, label: 'notarytool submit' },
		)
		const id = parseJson(submitted.output)?.id
		if (typeof id !== 'string' || !id)
			throw new Error('notarytool submit returned no submission id')
		log(`Notarization submission ${id} uploaded.`)
		const deadline = now() + deadlineMs
		for (let poll = 0; ; poll++) {
			const waited = (run ?? defaultRun)('xcrun', [
				'notarytool',
				'wait',
				id,
				...auth,
				'--timeout',
				waitTimeout,
				'--output-format',
				'json',
			])
			const waitOutput = `${waited.stdout ?? ''}${waited.stderr ?? ''}`
			if (waitOutput.trim()) log(waitOutput.trimEnd())
			if (
				waited.status !== 0 &&
				classifyFailure(waitOutput) !== 'transient' &&
				!/time(?:d)? ?out/i.test(waitOutput)
			)
				throw new Error(
					`notarytool wait ${id} failed with exit ${waited.status ?? waited.signal}`,
				)
			const info = runWithRetry(
				'xcrun',
				['notarytool', 'info', id, ...auth, '--output-format', 'json'],
				{ ...retry, label: `notarytool info ${id}` },
			)
			const status = parseJson(info.output)?.status
			if (status === 'Accepted') {
				log(`Notarization submission ${id} accepted.`)
				return { id }
			}
			if (status === 'Invalid' || status === 'Rejected') {
				try {
					runWithRetry('xcrun', ['notarytool', 'log', id, ...auth], {
						...retry,
						label: `notarytool log ${id}`,
					})
				} catch {
					log(`Could not fetch the notarization log for ${id}.`)
				}
				throw new Error(`Notarization submission ${id} is ${status}.`)
			}
			if (status !== 'In Progress')
				throw new Error(
					`Unexpected notarization status for ${id}: ${status ?? 'none'}`,
				)
			if (now() >= deadline)
				throw new Error(
					`Notarization submission ${id} was still in progress after ${deadlineMs / 60_000} minutes.`,
				)
			const delay = pollDelaysMs[Math.min(poll, pollDelaysMs.length - 1)]
			log(
				`Submission ${id} is still in progress; polling again in ${delay / 1000}s.`,
			)
			sleep(delay)
		}
	} finally {
		if (!zipDir) rmSync(workDir, { recursive: true, force: true })
	}
}

// Stapling only downloads the ticket for an accepted submission, so repeating
// it is safe and never contacts the notary service.
function staple(appPath, options = {}) {
	const { run, sleep, log, delaysMs = appleDelaysMs } = options
	const retry = { run, sleep, log, delaysMs }
	runWithRetry('xcrun', ['stapler', 'staple', '-v', appPath], {
		...retry,
		label: 'stapler staple',
	})
	runWithRetry('xcrun', ['stapler', 'validate', appPath], {
		...retry,
		label: 'stapler validate',
	})
}

if (require.main === module) {
	const [command, appPath] = process.argv.slice(2)
	if (!appPath || !['notarize', 'staple'].includes(command))
		throw new Error('Usage: mac-notarize.cjs notarize|staple <Kody.app>')
	if (command === 'notarize') notarize(appPath)
	else staple(appPath)
}

module.exports = { notarize, notaryAuth, parseJson, staple }
