const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync } = require('node:fs')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
	buildPackageAppLink,
	packageAppLinkFromArgv,
	parsePackageAppLink,
} = require('../package-app-links.cjs')
const {
	launcherIdentity,
	launcherName,
	launcherPlan,
	pngToIco,
	removeLauncher,
	writeLauncher,
} = require('../package-app-launchers.cjs')
const { createPackageAppWindows } = require('../package-app-windows.cjs')
const {
	PackageAppStore,
	installedNavigation,
	packageAppUrl,
	parseInstallRequest,
} = require('../package-apps.cjs')

const kodyOrigin = 'https://kody.codes'
const app = {
	owner: 'kent',
	packageName: 'weather',
	name: 'Weather',
	appOrigin: 'https://weather--kent.kody.run',
	openUrl: 'https://kody.codes/@kent/packages/weather/open',
	iconUrl: null,
}

test('kody://app links parse owner, package, and an in-app path', () => {
	assert.deepEqual(parsePackageAppLink('kody://app/kent/weather'), {
		owner: 'kent',
		packageName: 'weather',
		path: '/',
	})
	assert.deepEqual(
		parsePackageAppLink('kody://app/Kent/weather/days/3?unit=c#top'),
		{
			owner: 'kent',
			packageName: 'weather',
			path: '/days/3?unit=c#top',
		},
	)
	for (const value of [
		'https://kody.codes/@kent/packages/weather',
		'kody://apps/kent/weather',
		'kody://app/kent',
		'kody://app/-bad/weather',
		'kody://app/kent/we_ather',
		'kody://user:pass@app/kent/weather',
		'kody://app/kent/%E0%A4%A',
		'not a url',
	])
		assert.equal(parsePackageAppLink(value), null, value)
})

test('kody://app links round-trip and are found among process arguments', () => {
	assert.equal(
		buildPackageAppLink('kent', 'weather'),
		'kody://app/kent/weather',
	)
	const link = buildPackageAppLink('kent', 'weather', '/days')
	assert.equal(link, 'kody://app/kent/weather/days')
	assert.equal(parsePackageAppLink(link).path, '/days')
	assert.deepEqual(
		packageAppLinkFromArgv(['/opt/Kody/kody-desktop', '--flag', link]),
		{ owner: 'kent', packageName: 'weather', path: '/days' },
	)
	assert.equal(packageAppLinkFromArgv(['/opt/Kody/kody-desktop']), null)
})

test('install requests stay on the app origin or the matching Kody handoff', () => {
	assert.deepEqual(
		parseInstallRequest({ ...app, owner: 'Kent' }, { kodyOrigin }),
		app,
	)
	assert.equal(
		parseInstallRequest(
			{
				...app,
				openUrl: 'https://weather--kent.kody.run/',
				iconUrl: '/icon.png',
			},
			{ kodyOrigin },
		).iconUrl,
		'https://kody.codes/icon.png',
	)
	assert.equal(
		parseInstallRequest(
			{ ...app, iconUrl: 'https://evil.example/icon.png' },
			{ kodyOrigin },
		).iconUrl,
		null,
	)
	for (const bad of [
		{ appOrigin: 'http://weather--kent.kody.run' },
		{ appOrigin: kodyOrigin },
		{ openUrl: 'https://kody.codes/@kent/packages/other/open' },
		{ openUrl: 'https://kody.codes/account' },
		{ openUrl: 'https://evil.example/' },
		{ owner: '../kent' },
		{ packageName: '' },
	])
		assert.throws(() => parseInstallRequest({ ...app, ...bad }, { kodyOrigin }))
	assert.equal(
		parseInstallRequest(
			{
				...app,
				appOrigin: 'http://localhost:8788',
				openUrl: 'http://localhost:8788/',
			},
			{ kodyOrigin, allowLoopback: true },
		).appOrigin,
		'http://localhost:8788',
	)
})

test('installed windows stay on the app origin and send other pages to the browser', () => {
	assert.equal(
		installedNavigation(app, 'https://weather--kent.kody.run/x', kodyOrigin),
		'stay',
	)
	assert.equal(
		installedNavigation(
			app,
			'https://kody.codes/@kent/packages/weather/open/x',
			kodyOrigin,
		),
		'stay',
	)
	assert.equal(
		installedNavigation(app, 'https://kody.codes/login?x=1', kodyOrigin),
		'stay',
	)
	assert.equal(
		installedNavigation(app, 'https://kody.codes/oauth/authorize', kodyOrigin),
		'stay',
	)
	assert.equal(
		installedNavigation(app, 'https://kody.codes/account', kodyOrigin),
		'browser',
	)
	assert.equal(
		installedNavigation(
			app,
			'https://kody.codes/@kent/packages/other/open',
			kodyOrigin,
		),
		'browser',
	)
	assert.equal(
		installedNavigation(app, 'https://other--kent.kody.run/', kodyOrigin),
		'browser',
	)
	assert.equal(
		installedNavigation(app, 'file:///etc/passwd', kodyOrigin),
		'block',
	)
	assert.equal(
		installedNavigation(app, 'javascript:alert(1)', kodyOrigin),
		'block',
	)
})

test('app URLs open through the handoff when installed signed in, else the app origin', () => {
	assert.equal(
		packageAppUrl(app),
		'https://kody.codes/@kent/packages/weather/open',
	)
	assert.equal(
		packageAppUrl(app, '/days/3?unit=c#top'),
		'https://kody.codes/@kent/packages/weather/open/days/3?unit=c#top',
	)
	const publicApp = { ...app, openUrl: 'https://weather--kent.kody.run/' }
	assert.equal(packageAppUrl(publicApp), 'https://weather--kent.kody.run/')
	assert.equal(
		packageAppUrl(publicApp, '/days'),
		'https://weather--kent.kody.run/days',
	)
})

test('the store keeps one install per app, its bounds, and survives a reload', () => {
	const path = join(
		mkdtempSync(join(tmpdir(), 'kody-apps-')),
		'package-apps.json',
	)
	const store = new PackageAppStore({ path, fs })
	const first = store.put(app)
	store.put({ ...app, name: 'Weather 2' })
	assert.equal(store.list().length, 1)
	assert.equal(store.get('kent', 'weather').installedAt, first.installedAt)
	store.setBounds('kent', 'weather', { x: 10, y: 20, width: 800, height: 600 })
	store.setBounds('kent', 'weather', { x: 0, y: 0, width: 10, height: 10 })
	const reloaded = new PackageAppStore({ path, fs })
	assert.equal(reloaded.get('kent', 'weather').name, 'Weather 2')
	assert.deepEqual(reloaded.get('kent', 'weather').bounds, {
		x: 10,
		y: 20,
		width: 800,
		height: 600,
	})
	assert.equal(reloaded.remove('kent', 'weather'), true)
	assert.equal(new PackageAppStore({ path, fs }).list().length, 0)
	assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1)
})

test('launcher names and identities are safe on every platform', () => {
	assert.equal(launcherName('a/b:c*d?. '), 'a b c d')
	assert.equal(launcherName(''), 'Kody App')
	assert.equal(
		launcherIdentity('kent', 'weather'),
		'codes.kody.desktop.app.kent.weather',
	)
})

test('macOS launcher is a .app in ~/Applications/Kody Apps that opens the kody:// link', () => {
	const plan = launcherPlan({ platform: 'darwin', home: '/Users/k', app })
	assert.equal(plan.path, '/Users/k/Applications/Kody Apps/Weather.app')
	const script = plan.files.find((file) => file.path.endsWith('/MacOS/launch'))
	assert.equal(script.mode, 0o755)
	assert.match(
		script.content,
		/exec \/usr\/bin\/open 'kody:\/\/app\/kent\/weather'/,
	)
	const plist = plan.files.find((file) => file.path.endsWith('Info.plist'))
	assert.match(plist.content, /codes\.kody\.desktop\.app\.kent\.weather/)
	assert.match(
		plist.content,
		/<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/,
	)
})

test('Windows launcher is a Kody Apps Start Menu shortcut with its own AppUserModelID', () => {
	const plan = launcherPlan({
		platform: 'win32',
		home: 'C:\\Users\\k',
		appData: 'C:\\Users\\k\\AppData\\Roaming',
		systemRoot: 'C:\\Windows',
		iconDirectory: 'C:\\icons',
		app,
	})
	assert.match(plan.path, /Start Menu.Programs.Kody Apps.Weather\.lnk$/)
	assert.equal(plan.shortcut.args, 'kody://app/kent/weather')
	assert.match(plan.shortcut.target, /explorer\.exe$/)
	assert.equal(
		plan.shortcut.appUserModelId,
		'codes.kody.desktop.app.kent.weather',
	)
})

test('Linux launcher is a .desktop entry that runs Kody with the kody:// link', () => {
	const plan = launcherPlan({
		platform: 'linux',
		home: '/home/k',
		iconDirectory: '/home/k/.config/Kody/package-app-icons',
		executable: '/opt/Kody/kody-desktop',
		app: { ...app, name: 'Weather\nExec=evil' },
	})
	assert.equal(
		plan.path,
		'/home/k/.local/share/applications/kody-app-kent-weather.desktop',
	)
	const [entry] = plan.files
	assert.match(
		entry.content,
		/^Exec="\/opt\/Kody\/kody-desktop" "kody:\/\/app\/kent\/weather"$/m,
	)
	assert.match(entry.content, /^Name=Weather Exec=evil$/m)
	assert.equal(entry.content.match(/^Exec=/gm).length, 1)
	assert.match(
		entry.content,
		/^Icon=\/home\/k\/.config\/Kody\/package-app-icons\/kent--weather\.png$/m,
	)
})

test('ICO wraps the PNG with its size', () => {
	const png = Buffer.alloc(40)
	png.writeUInt32BE(64, 16)
	png.writeUInt32BE(256, 20)
	const ico = pngToIco(png)
	assert.equal(ico.readUInt16LE(4), 1)
	assert.equal(ico.readUInt8(6), 64)
	assert.equal(ico.readUInt8(7), 0)
	assert.equal(ico.readUInt32LE(14), 40)
	assert.equal(ico.readUInt32LE(18), 22)
	assert.ok(ico.subarray(22).equals(png))
})

test('writing and removing a Linux launcher touches only its own files', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-launcher-'))
	const plan = launcherPlan({
		platform: 'linux',
		home,
		iconDirectory: join(home, 'icons'),
		executable: '/opt/Kody/kody-desktop',
		app,
	})
	await writeLauncher(plan, { fs: fs.promises, icon: Buffer.from('png') })
	assert.match(readFileSync(plan.path, 'utf8'), /kody:\/\/app\/kent\/weather/)
	assert.equal(readFileSync(plan.iconPath, 'utf8'), 'png')
	await removeLauncher(plan, { fs: fs.promises })
	assert.equal(fs.existsSync(plan.path), false)
	assert.equal(fs.existsSync(plan.iconPath), false)
	assert.equal(
		fs.existsSync(join(home, '.local', 'share', 'applications')),
		true,
	)
})

test('writing a Windows launcher creates the shortcut with the app icon', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kody-win-'))
	const plan = launcherPlan({
		platform: 'win32',
		home: root,
		appData: root,
		systemRoot: 'C:\\Windows',
		iconDirectory: join(root, 'icons'),
		app,
	})
	const calls = []
	const png = Buffer.alloc(30)
	await writeLauncher(plan, {
		fs: fs.promises,
		icon: png,
		shell: { writeShortcutLink: (...args) => (calls.push(args), true) },
	})
	assert.equal(calls.length, 1)
	assert.equal(calls[0][0], plan.path)
	assert.equal(calls[0][2].icon, plan.iconPath)
	assert.equal(
		calls[0][2].appUserModelId,
		'codes.kody.desktop.app.kent.weather',
	)
	assert.equal(readFileSync(plan.iconPath).readUInt16LE(2), 1)
})

test('install is refused unless the session flag is on for the app owner', async () => {
	const path = join(
		mkdtempSync(join(tmpdir(), 'kody-apps-')),
		'package-apps.json',
	)
	const store = new PackageAppStore({ path, fs })
	const owners = []
	const windows = createPackageAppWindows({
		store,
		kodyOrigin,
		installAllowed: async (owner) => (owners.push(owner), false),
		launcherContext: {},
	})
	await assert.rejects(windows.install(app), /not available/)
	assert.deepEqual(owners, ['kent'])
	assert.equal(store.list().length, 0)
})
