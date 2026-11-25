const { join } = require('node:path')
const { buildPackageAppLink } = require('./package-app-links.cjs')

const launcherFolder = 'Kody Apps'

/** Filesystem- and shortcut-safe display name. */
function launcherName(name) {
	const safe = Array.from(String(name), (char) =>
		char.charCodeAt(0) < 32 ? ' ' : char,
	)
		.join('')
		.replace(/[<>:"/\\|?*]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[. ]+$/, '')
	return safe.slice(0, 64) || 'Kody App'
}

function launcherIdentity(owner, packageName) {
	return `codes.kody.desktop.app.${owner}.${packageName}`.replace(
		/[^a-zA-Z0-9.-]/g,
		'-',
	)
}

function xmlEscape(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function desktopEntryEscape(value) {
	return String(value).replace(/[\r\n]+/g, ' ')
}

function desktopExecArg(value) {
	return `"${String(value)
		.replace(/(["`$\\])/g, '\\$1')
		.replace(/%/g, '%%')}"`
}

/**
 * The files one launcher needs. Pure, so each platform layout is testable
 * without touching the disk; {@link writeLauncher} applies a plan.
 */
function launcherPlan(input) {
	const { platform, home, app } = input
	const name = launcherName(app.name)
	const link = buildPackageAppLink(app.owner, app.packageName)
	const id = launcherIdentity(app.owner, app.packageName)
	if (platform === 'darwin') {
		const bundle = join(home, 'Applications', launcherFolder, `${name}.app`)
		return {
			kind: 'mac-app',
			path: bundle,
			iconPath: join(bundle, 'Contents', 'Resources', 'AppIcon.icns'),
			files: [
				{
					path: join(bundle, 'Contents', 'Info.plist'),
					content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key><string>${xmlEscape(name)}</string>
	<key>CFBundleName</key><string>${xmlEscape(name)}</string>
	<key>CFBundleIdentifier</key><string>${xmlEscape(id)}</string>
	<key>CFBundleExecutable</key><string>launch</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
`,
				},
				{
					path: join(bundle, 'Contents', 'MacOS', 'launch'),
					content: `#!/bin/sh\nexec /usr/bin/open ${shellQuote(link)}\n`,
					mode: 0o755,
				},
			],
		}
	}
	if (platform === 'win32') {
		return {
			kind: 'windows-shortcut',
			path: join(
				input.appData,
				'Microsoft',
				'Windows',
				'Start Menu',
				'Programs',
				launcherFolder,
				`${name}.lnk`,
			),
			iconPath: join(
				input.iconDirectory,
				`${app.owner}--${app.packageName}.ico`,
			),
			shortcut: {
				target: join(input.systemRoot, 'explorer.exe'),
				args: link,
				description: `Open ${name} in Kody`,
				appUserModelId: id,
			},
			files: [],
		}
	}
	const file = join(
		input.dataHome ?? join(home, '.local', 'share'),
		'applications',
		`kody-app-${app.owner}-${app.packageName}.desktop`,
	)
	const iconPath = join(
		input.iconDirectory,
		`${app.owner}--${app.packageName}.png`,
	)
	return {
		kind: 'linux-desktop-entry',
		path: file,
		iconPath,
		files: [
			{
				path: file,
				content: `[Desktop Entry]
Type=Application
Version=1.5
Name=${desktopEntryEscape(name)}
Comment=${desktopEntryEscape(`Open ${name} in Kody`)}
Exec=${desktopExecArg(input.executable)} ${desktopExecArg(link)}
Icon=${desktopEntryEscape(iconPath)}
Terminal=false
Categories=Network;
StartupWMClass=${id}
`,
				mode: 0o755,
			},
		],
	}
}

/**
 * ICO container around one PNG image. Windows Vista and later read PNG
 * payloads inside ICO files, so no pixel conversion is needed.
 */
function pngToIco(png) {
	const header = Buffer.alloc(22)
	header.writeUInt16LE(0, 0)
	header.writeUInt16LE(1, 2)
	header.writeUInt16LE(1, 4)
	const width = png.readUInt32BE(16)
	const height = png.readUInt32BE(20)
	header.writeUInt8(width >= 256 ? 0 : width, 6)
	header.writeUInt8(height >= 256 ? 0 : height, 7)
	header.writeUInt8(0, 8)
	header.writeUInt8(0, 9)
	header.writeUInt16LE(1, 10)
	header.writeUInt16LE(32, 12)
	header.writeUInt32LE(png.length, 14)
	header.writeUInt32LE(22, 18)
	return Buffer.concat([header, png])
}

/**
 * Writes a launcher plan. `fs` is `node:fs/promises`; `icon` is a PNG
 * buffer or null; `shell` is Electron's shell (Windows shortcuts);
 * `run` executes a program (macOS icon conversion).
 */
async function writeLauncher(plan, { fs, icon, shell, run, tempPath }) {
	const { dirname } = require('node:path')
	await removeLauncher(plan, { fs })
	for (const file of plan.files) {
		await fs.mkdir(dirname(file.path), { recursive: true })
		await fs.writeFile(file.path, file.content, { mode: file.mode ?? 0o644 })
	}
	if (icon) {
		await fs.mkdir(dirname(plan.iconPath), { recursive: true })
		if (plan.kind === 'mac-app') {
			await fs.mkdir(dirname(tempPath), { recursive: true })
			await fs.writeFile(tempPath, icon)
			await run('/usr/bin/sips', [
				'-s',
				'format',
				'icns',
				tempPath,
				'--out',
				plan.iconPath,
			]).catch(() => {})
			await fs.rm(tempPath, { force: true })
		} else if (plan.kind === 'windows-shortcut') {
			await fs.writeFile(plan.iconPath, pngToIco(icon))
		} else {
			await fs.writeFile(plan.iconPath, icon)
		}
	}
	if (plan.kind === 'windows-shortcut') {
		await fs.mkdir(dirname(plan.path), { recursive: true })
		const written = shell.writeShortcutLink(plan.path, 'create', {
			...plan.shortcut,
			...(icon ? { icon: plan.iconPath, iconIndex: 0 } : {}),
		})
		if (!written)
			throw new Error('Windows did not create the Start Menu shortcut.')
	}
	if (plan.kind === 'mac-app') {
		// Finder caches bundle icons; touching the bundle refreshes it.
		const now = new Date()
		await fs.utimes(plan.path, now, now).catch(() => {})
	}
}

async function removeLauncher(plan, { fs }) {
	await fs.rm(plan.path, { recursive: true, force: true })
	if (plan.kind !== 'mac-app') await fs.rm(plan.iconPath, { force: true })
}

module.exports = {
	launcherIdentity,
	launcherName,
	launcherPlan,
	pngToIco,
	removeLauncher,
	writeLauncher,
}
