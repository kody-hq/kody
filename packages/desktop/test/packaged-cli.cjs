const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const { version } = require('../package.json')
const arch = process.arch
const platform = process.platform
assert.ok(['arm64', 'x64'].includes(arch), `Unsupported architecture: ${arch}`)
if (process.env.KODY_DESKTOP_ARCH)
	assert.equal(arch, process.env.KODY_DESKTOP_ARCH)
const output = process.argv[2]
	? resolve(process.argv[2])
	: resolve(__dirname, '../../../artifacts/desktop')
let executable
let resources
let os
let extensions
if (platform === 'darwin') {
	const bundle = join(
		output,
		arch === 'arm64' ? 'mac-arm64' : 'mac',
		'Kody.app',
	)
	executable = join(bundle, 'Contents/MacOS/Kody')
	resources = join(bundle, 'Contents/Resources')
	os = 'mac'
	extensions = ['dmg', 'zip']
} else if (platform === 'win32') {
	const bundle = join(
		output,
		arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
	)
	executable = join(bundle, 'Kody.exe')
	resources = join(bundle, 'resources')
	os = 'win'
	extensions = ['exe']
} else if (platform === 'linux') {
	const bundle = join(
		output,
		arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked',
	)
	executable = join(bundle, 'kody')
	resources = join(bundle, 'resources')
	os = 'linux'
	extensions = ['AppImage']
} else throw new Error(`Unsupported platform: ${platform}`)
assert.ok(existsSync(executable), `Missing packaged executable: ${executable}`)
const env = {
	...process.env,
	ELECTRON_RUN_AS_NODE: '1',
	KODY_SKIP_SKILL_REFRESH: '1',
	KODY_SKIP_GIT_HELPER_REFRESH: '1',
}
for (const key of [
	'NODE_OPTIONS',
	'NODE_PATH',
	'KODY_API_TOKEN',
	'KODY_API_URL',
	'KODY_MCP_URL',
	'KODY_TARGET',
	'KODY_ORG',
	'KODY_MOCK_SESSION_ID',
])
	delete env[key]
const options = { env, encoding: 'utf8', timeout: 30_000, windowsHide: true }
const runtime = JSON.parse(
	execFileSync(
		executable,
		[
			'-e',
			`
 const load = require('node:module').createRequire(require('node:path').join(process.argv[1],'app/package.json'))
 const cliLoad = require('node:module').createRequire(load.resolve('@kodycodes/cli'))
 cliLoad('@napi-rs/keyring')
 console.log(JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron}))
`,
			resources,
		],
		options,
	),
)
assert.equal(runtime.platform, platform)
assert.equal(runtime.arch, arch)
assert.ok(
	runtime.electron,
	'The packaged Electron runtime must execute the CLI.',
)
const cliVersion = execFileSync(
	executable,
	[join(resources, 'app/cli-host.cjs'), 'version'],
	options,
).trim()
assert.match(cliVersion, /\d+\.\d+\.\d+/)
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
	encoding: 'utf8',
}).trim()
const sourceDirty =
	execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
		encoding: 'utf8',
	}).trim().length > 0
const files = extensions.map((extension) => {
	const artifactArch = platform === 'linux' && arch === 'x64' ? 'x86_64' : arch
	const name = `Kody-${version}-${os}-${artifactArch}.${extension}`
	const bytes = readFileSync(join(output, name))
	return {
		name,
		bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	}
})
writeFileSync(
	join(output, `SHA256SUMS-${os}-${arch}.txt`),
	files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n',
)
writeFileSync(
	join(output, `build-info-${os}-${arch}.json`),
	JSON.stringify(
		{
			version,
			sourceSha,
			sourceDirty,
			platform,
			arch,
			cliVersion,
			electron: runtime.electron,
			files,
		},
		null,
		2,
	) + '\n',
)
console.log(
	`Packaged ${os}/${arch} CLI and native keyring load passed. Checksums written for ${files.length} binaries.`,
)
