const {
	app,
	BrowserWindow,
	Menu,
	dialog,
	shell,
	ipcMain,
	clipboard,
	net,
} = require('electron')
const { browserLogin } = require('./browser-login.cjs')
const { parseString } = require('set-cookie-parser')
const { supportsIntegratedTitlebar } = require('./site-capabilities.cjs')
const { attachWindowNavigation } = require('./window-navigation.cjs')
const {
	readFileSync,
	writeFileSync,
	mkdirSync,
	renameSync,
} = require('node:fs')
const { hostname } = require('node:os')
const { join } = require('node:path')
const { Runner } = require('./runner.cjs')
const { machineName } = require('./machine-name.cjs')
const { registrationIdentity } = require('./registration-identity.cjs')
const {
	existingRegistration,
	relationshipCopy,
	runnerView,
	shouldAdopt,
} = require('./machine-runner.cjs')
const {
	appOrigin: productionOrigin,
	isExternalUrl,
	isNavigationUrl,
} = require('./navigation.cjs')

app.setName('Kody')
let appOrigin = productionOrigin
const developmentUrl = process.argv
	.find((arg) => arg.startsWith('--app-url='))
	?.slice('--app-url='.length)
if (developmentUrl && !app.isPackaged) {
	const url = new URL(developmentUrl)
	if (
		!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
		!['http:', 'https:'].includes(url.protocol)
	)
		throw new Error('Development app URL must be a loopback origin.')
	appOrigin = url.origin
}
function isCurrentAppUrl(value) {
	try {
		return new URL(value).origin === appOrigin
	} catch {
		return false
	}
}
let navigation
let windowOpening
ipcMain.handle('kody:navigation', (event, command) => {
	if (!navigation?.accepts(event))
		throw new Error('Navigation is only available to the main Kody document.')
	return navigation.command(command)
})
let loginAttempt
ipcMain.handle('kody:authentication', async (event, mode) => {
	if (!navigation?.accepts(event))
		throw new Error('Sign-in is only available to the main Kody document.')
	if (mode === 'cancel') {
		loginAttempt?.cancel()
		return
	}
	if (mode !== 'login' && mode !== 'signup')
		throw new Error('Invalid sign-in action.')
	if (loginAttempt) return { error: 'Browser sign-in is already open.' }
	const targetSession = window.webContents.session
	loginAttempt = browserLogin({
		origin: appOrigin,
		mode,
		openExternal: (url) => shell.openExternal(url),
		exchange: async (data) => {
			const response = await fetch(`${appOrigin}/desktop/session`, {
				method: 'POST',
				redirect: 'error',
				credentials: 'omit',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: data.code, verifier: data.verifier }),
				signal: AbortSignal.any([data.signal, AbortSignal.timeout(20_000)]),
			})
			if (response.status !== 204) throw new Error('Sign-in failed.')
			const cookies = response.headers
				.getSetCookie()
				.map((value) => parseString(value, { decodeValues: false }))
			const cookie = cookies.find((cookie) => cookie.name === 'kody_session')
			if (
				!cookie ||
				!cookie.httpOnly ||
				cookie.domain ||
				cookie.path !== '/' ||
				(appOrigin.startsWith('https:') && !cookie.secure)
			)
				throw new Error('Invalid sign-in session.')
			data.signal.throwIfAborted()
			await targetSession.cookies.set({
				url: appOrigin,
				name: cookie.name,
				value: cookie.value,
				path: '/',
				httpOnly: true,
				secure: !!cookie.secure,
				sameSite: 'lax',
				expirationDate: cookie.maxAge
					? Date.now() / 1000 + cookie.maxAge
					: cookie.expires?.getTime() / 1000,
			})
		},
	})
	try {
		await loginAttempt.result
		if (!quitting) {
			await showApp('/account')
			window.focus()
		}
		return {}
	} catch (error) {
		if (error.message === 'Browser sign-in canceled.') return {}
		return { error: error.message }
	} finally {
		loginAttempt = null
	}
})
const runner = new Runner()
let window
let busy = false
let quitting = false
let state = { ecid: null, enabled: false }
function statePath() {
	return join(app.getPath('userData'), 'machine.json')
}
function saveState() {
	mkdirSync(app.getPath('userData'), { recursive: true })
	const temporary = `${statePath()}.tmp`
	writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
	renameSync(temporary, statePath())
}
function loadState() {
	try {
		const saved = JSON.parse(readFileSync(statePath(), 'utf8'))
		if (
			typeof saved.ecid === 'string' &&
			/^ec_[A-Za-z0-9_-]+$/.test(saved.ecid)
		) {
			state = { ecid: saved.ecid, enabled: saved.enabled === true }
		}
	} catch (error) {
		if (error.code !== 'ENOENT')
			throw new Error(
				`Could not read desktop machine settings: ${error.message}`,
			)
	}
}
async function action(run) {
	if (busy || quitting) return
	busy = true
	updateMenu()
	try {
		await run()
	} catch (error) {
		if (!quitting) dialog.showErrorBox('Kody', error.message)
	} finally {
		busy = false
		if (!quitting) updateMenu()
	}
}
async function register() {
	const identity = registrationIdentity(
		JSON.parse(await runner.command(['whoami', '--json'])),
	)
	machineStatus = await readMachineStatus()
	const existing = existingRegistration(machineStatus)
	if (existing) {
		const { response } = await dialog.showMessageBox({
			type: 'question',
			message: `This machine is already registered${existing.name ? ` as ${existing.name}` : ''}`,
			detail: `${relationshipCopy}\n\nUse the existing registration (${existing.ecid}) instead of creating a second context.`,
			buttons: ["Use this machine's existing registration", 'Cancel'],
			defaultId: 0,
			cancelId: 1,
		})
		if (response === 0 && !quitting) await useExistingRegistration(existing)
		return
	}
	const name = machineName(hostname())
	const { response } = await dialog.showMessageBox({
		type: 'question',
		message: `Register ${name}?`,
		detail: `${identity.trim()}\n\nUses the CLI account shown above. Registration does not add this machine to an execution chain.`,
		buttons: ['Register', 'Cancel'],
		defaultId: 0,
		cancelId: 1,
	})
	if (response !== 0 || quitting) return
	const result = JSON.parse(
		await runner.command(['context', 'register', '--name', name, '--json']),
	)
	if (
		typeof result.ecid !== 'string' ||
		!/^ec_[A-Za-z0-9_-]+$/.test(result.ecid)
	)
		throw new Error('The CLI did not return an execution context id.')
	state = { ecid: result.ecid, enabled: process.platform !== 'win32' }
	saveState()
	void refreshCommands()
	void refreshAutoUpdate()
	if (state.enabled && !quitting) runner.start(state.ecid)
	if (quitting) return
	await dialog
		.showMessageBox({
			message: `Registered ${name}`,
			detail:
				process.platform === 'win32'
					? 'The desktop shell works on Windows, but the CLI execution runtime currently supports only macOS and Linux.'
					: 'The runner is starting. Choose this machine in your execution chain on the website to use it by default. Folder access still requires both a local policy and a server grant.',
			buttons: ['Open execution contexts', 'Done'],
		})
		.then(({ response: choice }) => {
			if (choice === 0 && !quitting) showApp('/account/execution-contexts')
		})
}
let commandsEnabled = false
async function refreshCommands() {
	if (!state.ecid || process.platform === 'win32') return
	try {
		const status = JSON.parse(
			await runner.command([
				'context',
				'commands',
				'status',
				'--context',
				state.ecid,
				'--json',
			]),
		)
		commandsEnabled =
			status.local?.enabled === true &&
			status.contexts?.[0]?.commands?.enabled === true
	} catch {
		commandsEnabled = false
	}
	if (!quitting) updateMenu()
}
// What the CLI knows about this machine's runner: service, lock holder,
// registrations. Polled so the menu follows a service started elsewhere.
let machineStatus = null
async function readMachineStatus() {
	try {
		return JSON.parse(
			await runner.command(
				[
					'daemon',
					'status',
					...(state.ecid ? ['--context', state.ecid] : []),
					'--json',
				],
				{ okCodes: [0, 1] },
			),
		)
	} catch {
		return null
	}
}
async function refreshMachine() {
	if (process.platform === 'win32') return
	machineStatus = await readMachineStatus()
	const existing = existingRegistration(machineStatus)
	// Adopt the runner the CLI already runs for this machine.
	if (!state.ecid && existing && shouldAdopt(machineStatus) && !runner.daemon) {
		state = { ecid: existing.ecid, enabled: false }
		saveState()
		void refreshCommands()
	}
	if (!quitting && app.isReady()) updateMenu()
}
function currentView() {
	return runnerView({
		status: machineStatus,
		ownRunning: runner.daemon !== null,
		hasRegistration: !!state.ecid,
	})
}
async function startRunner() {
	await refreshMachine()
	const view = currentView()
	if (view.mode === 'service') {
		await runner.command(['daemon', 'start', '--context', state.ecid, '--json'])
	} else if (view.mode === 'none') {
		runner.start(state.ecid)
		state.enabled = true
		saveState()
	}
	await refreshMachine()
}
async function stopRunner() {
	const view = currentView()
	if (view.mode === 'desktop') {
		state.enabled = false
		saveState()
		await runner.stop()
	} else if (view.mode === 'service' || view.mode === 'external') {
		await runner.command(['daemon', 'stop', '--context', state.ecid, '--json'])
	}
	await refreshMachine()
}
async function restartRunner() {
	const view = currentView()
	if (view.mode === 'desktop') {
		await runner.stop()
		runner.start(state.ecid)
	} else if (view.mode === 'service') {
		await runner.command(['daemon', 'restart', '--context', state.ecid])
	}
	await refreshMachine()
}
async function useExistingRegistration(existing) {
	state = { ecid: existing.ecid, enabled: false }
	saveState()
	void refreshCommands()
	await refreshMachine()
	if (currentView().mode === 'none' && process.platform !== 'win32') {
		runner.start(state.ecid)
		state.enabled = true
		saveState()
	}
}

// Daemon auto-update (on by default). It is a machine-wide switch in the CLI
// local policy, shared with `kody daemon auto-update on|off`.
let autoUpdateEnabled = true
async function refreshAutoUpdate() {
	try {
		const status = JSON.parse(
			await runner.command(['daemon', 'auto-update', 'status', '--json']),
		)
		autoUpdateEnabled = status.enabled !== false
	} catch {
		autoUpdateEnabled = true
	}
	if (!quitting) updateMenu()
}
async function toggleAutoUpdate() {
	await runner.command([
		'daemon',
		'auto-update',
		autoUpdateEnabled ? 'off' : 'on',
		'--json',
	])
	await refreshAutoUpdate()
}
async function toggleCommands() {
	const enable = !commandsEnabled
	if (enable) {
		const { response } = await dialog.showMessageBox({
			type: 'warning',
			message: 'Allow Kody runs to run commands on this machine?',
			detail:
				'Runs on this machine that have the command grant (you, and anyone you explicitly share host commands with) can run any shell command as your user account, with no approval per command: install software, read and change your files, use your network. Every command is recorded in the context audit log. Turn it off here, with `kody context commands off`, or on the website.',
			buttons: ['Allow commands', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
		})
		if (response !== 0 || quitting) return
	}
	await runner.command([
		'context',
		'commands',
		enable ? 'on' : 'off',
		'--context',
		state.ecid,
		'--json',
	])
	await refreshCommands()
}
function updateMenu() {
	const view = currentView()
	const running =
		view.mode !== 'none' && !(view.mode === 'service' && view.canStart)
	const existing = existingRegistration(machineStatus)
	const available = !busy && !quitting
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
			{ label: 'File', submenu: [{ role: 'close' }] },
			{
				label: 'Machine',
				submenu: [
					{
						label: busy ? 'Working…' : view.label,
						enabled: false,
					},
					{ type: 'separator' },
					{
						label: 'Sign in to CLI…',
						enabled: available && !running,
						click: () =>
							action(async () => {
								await runner.command(['login'])
								if (quitting) return
								await dialog.showMessageBox({
									message: 'CLI sign-in complete',
									buttons: ['OK'],
								})
							}),
					},
					existing && !state.ecid
						? {
								label: "Use this machine's existing registration…",
								enabled: available,
								click: () => action(register),
							}
						: {
								label: 'Register this machine…',
								enabled: available && !state.ecid,
								click: () => action(register),
							},
					{
						label: 'Start runner',
						enabled:
							available &&
							!!state.ecid &&
							view.canStart &&
							process.platform !== 'win32',
						click: () => action(startRunner),
					},
					{
						label: 'Stop runner',
						enabled: available && view.canStop,
						click: () => action(stopRunner),
					},
					{
						label: 'Restart runner',
						enabled: available && view.canRestart,
						click: () => action(restartRunner),
					},
					{
						label: 'Forget desktop registration…',
						enabled: available && !!state.ecid && !running,
						click: () =>
							action(async () => {
								const { response } = await dialog.showMessageBox({
									message: 'Forget this registration in the desktop app?',
									detail:
										'The CLI keys and server registration stay in place. Revoke the context on the website to remove access.',
									buttons: ['Cancel', 'Forget'],
									defaultId: 0,
									cancelId: 0,
								})
								if (response === 1) {
									state = { ecid: null, enabled: false }
									saveState()
								}
							}),
					},
					{
						label: 'Allow commands',
						type: 'checkbox',
						checked: commandsEnabled,
						enabled: available && !!state.ecid && process.platform !== 'win32',
						click: () => action(toggleCommands),
					},
					{
						label: 'Keep runner up to date',
						type: 'checkbox',
						checked: autoUpdateEnabled,
						enabled: available,
						click: () => action(toggleAutoUpdate),
					},
					{ type: 'separator' },
					{
						label: 'Execution contexts',
						click: () => showApp('/account/execution-contexts'),
					},
					{
						label: 'Execution context experiment',
						click: () => showApp('/account/experiments'),
					},
					{
						label: 'Runner details…',
						click: () =>
							dialog.showMessageBox({
								message: view.label,
								detail: `${relationshipCopy}\n\n${
									view.mode === 'desktop' || view.mode === 'none'
										? runner.output || 'No runner output yet.'
										: 'This runner is not started by the app: see its log with `kody daemon logs`.'
								}`,
								buttons: ['OK'],
							}),
					},
					...(process.platform !== 'darwin'
						? [{ type: 'separator' }, { role: 'quit' }]
						: []),
				],
			},
			{ role: 'editMenu' },
			{
				label: 'Navigate',
				submenu: [
					{
						label: 'Back',
						accelerator: 'CmdOrCtrl+[',
						click: () => navigation?.command('back'),
					},
					{
						label: 'Forward',
						accelerator: 'CmdOrCtrl+]',
						click: () => navigation?.command('forward'),
					},
					{
						label: 'Home',
						accelerator: 'CmdOrCtrl+Shift+H',
						click: () => showApp('/account'),
					},
					{
						label: 'Copy page address',
						accelerator: 'CmdOrCtrl+Shift+C',
						click: () => navigation?.command('copy-address'),
					},
				],
			},
			{ role: 'viewMenu' },
			{ role: 'windowMenu' },
		]),
	)
}
async function showApp(path) {
	const creating = !window || window.isDestroyed()
	if (creating) {
		windowOpening ??= createWindow()
		try {
			await windowOpening
		} finally {
			windowOpening = null
		}
	}
	if (quitting || !window || window.isDestroyed()) return
	window.show()
	window.focus()
	if (!creating && !path) return
	const shownWindow = window
	void shownWindow
		.loadURL(`${appOrigin}${path ?? '/account'}`)
		.catch((error) => {
			if (!quitting && !shownWindow.isDestroyed())
				dialog.showErrorBox('Could not load Kody', error.message)
		})
}
async function supportsBrowserLogin() {
	try {
		const response = await net.fetch(`${appOrigin}/login`, {
			method: 'HEAD',
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		})
		return (
			response.ok &&
			response.headers.get('X-Kody-Desktop-Authentication') === '1'
		)
	} catch {
		return false
	}
}
async function createWindow() {
	const [integratedTitlebar, browserAuthentication] = await Promise.all([
		process.platform === 'darwin'
			? supportsIntegratedTitlebar(appOrigin, net.fetch)
			: false,
		supportsBrowserLogin(),
	])
	if (quitting) return
	window = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 720,
		minHeight: 480,
		title: 'Kody',
		icon: join(__dirname, 'assets/icon.png'),
		...(integratedTitlebar
			? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 } }
			: {}),
		backgroundColor: '#ffffff',
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webviewTag: false,
			partition: 'persist:kody',
			preload: join(__dirname, 'preload.cjs'),
			additionalArguments: [
				`--kody-app-origin=${appOrigin}`,
				...(browserAuthentication ? ['--kody-browser-login'] : []),
			],
		},
	})
	navigation = attachWindowNavigation(window, {
		appOrigin,
		clipboard,
		shell,
		integratedTitlebar,
	})
	window.webContents.session.setPermissionRequestHandler(
		(contents, permission, callback, details) => {
			callback(
				permission === 'clipboard-sanitized-write' &&
					details.isMainFrame &&
					isCurrentAppUrl(details.requestingUrl) &&
					isCurrentAppUrl(contents.getURL()),
			)
		},
	)
	window.webContents.session.setPermissionCheckHandler(
		(contents, permission, origin, details) =>
			permission === 'clipboard-sanitized-write' &&
			details.isMainFrame &&
			isCurrentAppUrl(origin) &&
			!!contents &&
			isCurrentAppUrl(contents.getURL()),
	)
	window.webContents.on('will-attach-webview', (event) =>
		event.preventDefault(),
	)
	function external(url) {
		if (isExternalUrl(url))
			void shell
				.openExternal(url)
				.catch((error) =>
					dialog.showErrorBox('Could not open link', error.message),
				)
	}
	window.webContents.on('will-navigate', (event, url) => {
		if (!isCurrentAppUrl(url) && !isNavigationUrl(url)) {
			event.preventDefault()
			external(url)
		}
	})
	window.webContents.on('will-redirect', (event, url) => {
		if (!isCurrentAppUrl(url) && !isNavigationUrl(url)) {
			event.preventDefault()
			external(url)
		}
	})
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (isCurrentAppUrl(url))
			showApp(new URL(url).pathname + new URL(url).search + new URL(url).hash)
		else external(url)
		return { action: 'deny' }
	})
	window.on('closed', () => {
		window = null
		navigation = null
	})
}
runner.on('change', () => {
	if (app.isReady() && !quitting) updateMenu()
})
runner.on('ended', () =>
	dialog.showErrorBox(
		'Kody runner stopped',
		runner.output ||
			'The CLI runner exited. Use Machine > Start runner to try again.',
	),
)
runner.on('shutdown-error', (error) =>
	dialog.showErrorBox('Could not stop runner', error.message),
)

if (!app.requestSingleInstanceLock()) app.quit()
else {
	app.on('second-instance', () => showApp())
	app.on('activate', () => {
		if (!window) showApp()
	})
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit()
	})
	app.on('before-quit', (event) => {
		loginAttempt?.cancel()
		if (quitting) return
		event.preventDefault()
		quitting = true
		void runner
			.close()
			.then(() => app.quit())
			.catch((error) => {
				dialog.showErrorBox('Could not stop runner', error.message)
				app.exit(1)
			})
	})
	app
		.whenReady()
		.then(async () => {
			if (process.platform === 'darwin')
				app.dock.setIcon(join(__dirname, 'assets/icon.png'))
			loadState()
			updateMenu()
			await showApp()
			await refreshMachine()
			if (
				!quitting &&
				state.enabled &&
				state.ecid &&
				currentView().mode === 'none'
			)
				runner.start(state.ecid)
			setInterval(() => {
				if (!busy && !quitting) void refreshMachine()
			}, 15_000).unref()
			void refreshCommands()
			void refreshAutoUpdate()
		})
		.catch((error) => {
			dialog.showErrorBox('Could not start Kody', error.message)
			app.quit()
		})
}
