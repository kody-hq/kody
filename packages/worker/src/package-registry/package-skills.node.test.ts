import { expect, test } from 'vitest'
import {
	buildPackageSkillsIndex,
	buildSkillUri,
	collectPackageSkills,
	digestSnapshotContent,
	skillResourceIsBinary,
	guessMimeType,
	packageSkillMaxFiles,
	parseKodyIdForSkillUri,
	parseSkillFrontmatter,
	validatePackageSkills,
} from './package-skills.ts'

const kodyId = '@kentcdodds/ship-pr'

function skillMd(input: {
	name?: string
	description?: string
	extra?: string
	body?: string
}) {
	const lines = ['---']
	if (input.name !== undefined) lines.push(`name: ${input.name}`)
	if (input.description !== undefined) {
		lines.push(`description: ${input.description}`)
	}
	if (input.extra) lines.push(input.extra)
	lines.push('---', input.body ?? '# Body\n')
	return lines.join('\n')
}

test('collects a valid skill with URIs, digests, and sorted resources', async () => {
	const skillBody = skillMd({
		name: 'pdf-tools',
		description: 'Work with PDFs.',
	})
	const skills = await collectPackageSkills({
		kodyId,
		files: {
			'package.json': '{}',
			'skills/pdf-tools/SKILL.md': skillBody,
		},
	})
	expect(skills).toHaveLength(1)
	const [skill] = skills
	expect(skill).toMatchObject({
		name: 'pdf-tools',
		skillRoot: 'skills/pdf-tools',
		uriPrefix: ['kentcdodds', 'ship-pr'],
		uri: 'skill://kentcdodds/ship-pr/pdf-tools/SKILL.md',
		frontmatter: { name: 'pdf-tools', description: 'Work with PDFs.' },
	})
	const resource = skill!.resources[0]!
	expect(resource).toMatchObject({
		relativePath: 'SKILL.md',
		packagePath: 'skills/pdf-tools/SKILL.md',
		uri: 'skill://kentcdodds/ship-pr/pdf-tools/SKILL.md',
		mimeType: 'text/markdown',
		content: skillBody,
		size: new TextEncoder().encode(skillBody).byteLength,
	})
	expect(resource.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
})

test('collects multi-file skills with SKILL.md first and supporting files sorted', async () => {
	const skills = await collectPackageSkills({
		kodyId,
		files: {
			'skills/b-skill/SKILL.md': skillMd({
				name: 'b-skill',
				description: 'B.',
			}),
			'skills/a-skill/scripts/run.py': 'print(1)',
			'skills/a-skill/references/x.md': '# x',
			'skills/a-skill/SKILL.md': skillMd({
				name: 'a-skill',
				description: 'A.',
			}),
			'skills/a-skill/assets/logo.png': 'not-really-png',
		},
	})
	expect(skills.map((skill) => skill.name)).toEqual(['a-skill', 'b-skill'])
	expect(skills[0]!.resources.map((resource) => resource.relativePath)).toEqual(
		['SKILL.md', 'assets/logo.png', 'references/x.md', 'scripts/run.py'],
	)
	const byPath = new Map(
		skills[0]!.resources.map((resource) => [resource.relativePath, resource]),
	)
	expect(byPath.get('references/x.md')).toMatchObject({
		uri: 'skill://kentcdodds/ship-pr/a-skill/references/x.md',
		mimeType: 'text/markdown',
	})
	expect(byPath.get('scripts/run.py')!.mimeType).toBe('text/x-python')
	expect(byPath.get('assets/logo.png')!.mimeType).toBe('image/png')
})

test('returns no skills for packages without a skills directory', async () => {
	expect(
		await collectPackageSkills({ kodyId, files: { 'package.json': '{}' } }),
	).toEqual([])
	await expect(
		validatePackageSkills({ kodyId: 'not-scoped', files: {} }),
	).resolves.toEqual({
		ok: true,
		skills: [],
		message: 'No package skills found.',
	})
})

test('ignores skills trees without a direct SKILL.md', async () => {
	const skills = await collectPackageSkills({
		kodyId,
		files: {
			'skills/README.md': '# readme',
			'skills/foo': 'a file named foo',
			'skills/bar/notes.txt': 'no SKILL.md here',
			'skills/nested/deeper/SKILL.md': skillMd({
				name: 'deeper',
				description: 'Not direct.',
			}),
		},
	})
	expect(skills).toEqual([])
})

test.each([
	['underscore', 'bad_name'],
	['too long', 'a'.repeat(65)],
])('rejects invalid skill name (%s)', async (_label, name) => {
	await expect(
		collectPackageSkills({
			kodyId,
			files: {
				[`skills/${name}/SKILL.md`]: skillMd({ name, description: 'Desc.' }),
			},
		}),
	).rejects.toThrow(`skills/${name}`)
})

test('accepts a 64 character name', async () => {
	const name = 'a'.repeat(64)
	const skills = await collectPackageSkills({
		kodyId,
		files: {
			[`skills/${name}/SKILL.md`]: skillMd({ name, description: 'Desc.' }),
		},
	})
	expect(skills[0]!.name).toBe(name)
})

test('rejects frontmatter name that does not match the directory', async () => {
	await expect(
		collectPackageSkills({
			kodyId,
			files: {
				'skills/foo/SKILL.md': skillMd({ name: 'bar', description: 'Desc.' }),
			},
		}),
	).rejects.toThrow(/skills\/foo\/SKILL\.md.*"bar".*"foo"/)
})

test('rejects missing name, missing description, and oversize description', async () => {
	await expect(
		collectPackageSkills({
			kodyId,
			files: { 'skills/foo/SKILL.md': skillMd({ description: 'Desc.' }) },
		}),
	).rejects.toThrow(/skills\/foo\/SKILL\.md.*"name"/)
	await expect(
		collectPackageSkills({
			kodyId,
			files: { 'skills/foo/SKILL.md': skillMd({ name: 'foo' }) },
		}),
	).rejects.toThrow(/skills\/foo\/SKILL\.md.*"description"/)
	await expect(
		collectPackageSkills({
			kodyId,
			files: {
				'skills/foo/SKILL.md': skillMd({ name: 'foo', description: '""' }),
			},
		}),
	).rejects.toThrow(/"description"/)
	await expect(
		collectPackageSkills({
			kodyId,
			files: {
				'skills/foo/SKILL.md': skillMd({
					name: 'foo',
					description: 'd'.repeat(1025),
				}),
			},
		}),
	).rejects.toThrow(/1-1024/)
})

test('rejects missing frontmatter fences', async () => {
	await expect(
		collectPackageSkills({
			kodyId,
			files: { 'skills/foo/SKILL.md': '# no frontmatter' },
		}),
	).rejects.toThrow(/opening/)
	await expect(
		collectPackageSkills({
			kodyId,
			files: { 'skills/foo/SKILL.md': '---\nname: foo\ndescription: x\n' },
		}),
	).rejects.toThrow(/closing/)
})

test('digest is byte-length based and lowercase hex', async () => {
	const first = await digestSnapshotContent('héllo', 'SKILL.md')
	expect(first.size).toBe(6)
	expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
	expect((await digestSnapshotContent('héllo!', 'SKILL.md')).digest).not.toBe(
		first.digest,
	)
})

test('binary skill assets digest latin-1 snapshot bytes, not UTF-8', async () => {
	const pngMagic = String.fromCharCode(
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
	)
	const path = 'skills/a-skill/assets/logo.png'
	const snap = await digestSnapshotContent(pngMagic, path)
	const asUtf8 = await digestSnapshotContent(pngMagic, 'SKILL.md')
	expect(snap.size).toBe(8)
	expect(asUtf8.size).toBeGreaterThan(8)
	expect(snap.digest).not.toBe(asUtf8.digest)
	expect(skillResourceIsBinary(path, pngMagic)).toBe(true)
	expect(skillResourceIsBinary('skills/a-skill/SKILL.md', '# hi')).toBe(false)
})

test('builds URIs from kody ids', () => {
	expect(parseKodyIdForSkillUri('@owner/slug')).toEqual({
		owner: 'owner',
		slug: 'slug',
	})
	expect(parseKodyIdForSkillUri('owner/slug')).toEqual({
		owner: 'owner',
		slug: 'slug',
	})
	expect(() => parseKodyIdForSkillUri('@owner')).toThrow(/@owner/)
	expect(() => parseKodyIdForSkillUri('@a/b/c')).toThrow(/@a\/b\/c/)
	expect(() => parseKodyIdForSkillUri('@/slug')).toThrow(/@\/slug/)
	expect(buildSkillUri(['owner', 'slug'], 'foo/SKILL.md')).toBe(
		'skill://owner/slug/foo/SKILL.md',
	)
	expect(buildSkillUri(['owner', 'slug'], 'foo/')).toBe(
		'skill://owner/slug/foo',
	)
})

test('rejects skills for packages whose kody id is not scoped', async () => {
	await expect(
		collectPackageSkills({
			kodyId: 'unscoped',
			files: {
				'skills/foo/SKILL.md': skillMd({ name: 'foo', description: 'Desc.' }),
			},
		}),
	).rejects.toThrow(/unscoped/)
})

test('guesses mime types', () => {
	expect(guessMimeType('a.md')).toBe('text/markdown')
	expect(guessMimeType('a.JSON')).toBe('application/json')
	for (const ext of ['js', 'ts', 'mjs', 'cjs']) {
		expect(guessMimeType(`a.${ext}`)).toBe('text/plain')
	}
	expect(guessMimeType('a.py')).toBe('text/x-python')
	expect(guessMimeType('a.sh')).toBe('application/x-sh')
	expect(guessMimeType('a.jpeg')).toBe('image/jpeg')
	expect(guessMimeType('a.svg')).toBe('image/svg+xml')
	expect(guessMimeType('Makefile')).toBe('application/octet-stream')
	expect(guessMimeType('a.bin')).toBe('application/octet-stream')
})

test('enforces file count and byte size limits', async () => {
	const files: Record<string, string> = {
		'skills/foo/SKILL.md': skillMd({ name: 'foo', description: 'Desc.' }),
		'skills/foo/a.txt': 'aaaa',
		'skills/foo/b.txt': 'bbbb',
	}
	await expect(
		collectPackageSkills({ kodyId, files, limits: { maxFiles: 2 } }),
	).rejects.toThrow(/3 files.*limit is 2/)
	await expect(
		collectPackageSkills({ kodyId, files, limits: { maxBytes: 10 } }),
	).rejects.toThrow(/total size limit/)
	await expect(
		collectPackageSkills({
			kodyId,
			files,
			limits: { maxFiles: 3, maxBytes: 1024 },
		}),
	).resolves.toHaveLength(1)

	const many: Record<string, string> = {
		'skills/foo/SKILL.md': skillMd({ name: 'foo', description: 'Desc.' }),
	}
	for (let index = 0; index < packageSkillMaxFiles; index += 1) {
		many[`skills/foo/f${index}.txt`] = 'x'
	}
	await expect(collectPackageSkills({ kodyId, files: many })).rejects.toThrow(
		/513 files/,
	)
})

test('parses quoted descriptions, optional fields, and metadata maps', () => {
	const { frontmatter, body } = parseSkillFrontmatter({
		skillPath: 'skills/foo/SKILL.md',
		raw: [
			'---',
			'name: foo',
			'description: "Use when: doing things # not a comment"',
			"license: 'Apache-2.0'",
			'compatibility: Requires git',
			'allowed-tools: Bash(git:*) Read',
			'metadata:',
			'  author: example-org',
			'  version: "1.0"',
			"  quote: 'it''s'",
			'---',
			'',
			'# Title',
		].join('\n'),
	})
	expect(frontmatter).toEqual({
		name: 'foo',
		description: 'Use when: doing things # not a comment',
		license: 'Apache-2.0',
		compatibility: 'Requires git',
		'allowed-tools': 'Bash(git:*) Read',
		metadata: { author: 'example-org', version: '1.0', quote: "it's" },
	})
	expect(body).toBe('# Title')
})

test('joins indented description continuation lines with spaces', () => {
	const { frontmatter } = parseSkillFrontmatter({
		skillPath: 'skills/foo/SKILL.md',
		raw: [
			'---',
			'name: foo',
			'description:',
			'  First line of the description',
			'  second line with more detail.',
			'---',
			'body',
		].join('\r\n'),
	})
	expect(frontmatter.description).toBe(
		'First line of the description second line with more detail.',
	)
	const folded = parseSkillFrontmatter({
		skillPath: 'skills/foo/SKILL.md',
		raw: '---\nname: foo\ndescription: >-\n  folded one\n  folded two\n---\n',
	})
	expect(folded.frontmatter.description).toBe('folded one folded two')
})

test('rejects malformed frontmatter lines and duplicate keys', () => {
	expect(() =>
		parseSkillFrontmatter({
			skillPath: 'skills/foo/SKILL.md',
			raw: '---\nname: foo\nnot a pair\n---\n',
		}),
	).toThrow(/skills\/foo\/SKILL\.md.*invalid frontmatter line/)
	expect(() =>
		parseSkillFrontmatter({
			skillPath: 'skills/foo/SKILL.md',
			raw: '---\nname: foo\nname: bar\ndescription: x\n---\n',
		}),
	).toThrow(/more than once/)
	expect(() =>
		parseSkillFrontmatter({
			skillPath: 'skills/foo/SKILL.md',
			raw: '---\nname: foo\ndescription: x\nmetadata: oops\n---\n',
		}),
	).toThrow(/metadata/)
	expect(() =>
		parseSkillFrontmatter({
			skillPath: 'skills/foo/SKILL.md',
			raw: '---\nname: foo\ndescription: x\nmetadata:\n  just text\n---\n',
		}),
	).toThrow(/metadata/)
})

test('validatePackageSkills reports failures instead of throwing', async () => {
	const bad = await validatePackageSkills({
		kodyId,
		files: { 'skills/foo/SKILL.md': skillMd({ name: 'foo' }) },
	})
	expect(bad.ok).toBe(false)
	expect(bad.message).toMatch(/skills\/foo\/SKILL\.md/)
	const good = await validatePackageSkills({
		kodyId,
		files: {
			'skills/foo/SKILL.md': skillMd({ name: 'foo', description: 'Desc.' }),
		},
	})
	expect(good).toMatchObject({ ok: true })
	expect(good.message).toBe('Validated 1 package skill: foo.')
})

test('buildPackageSkillsIndex strips file contents', async () => {
	const skills = await collectPackageSkills({
		kodyId,
		files: {
			'skills/foo/SKILL.md': skillMd({ name: 'foo', description: 'Desc.' }),
			'skills/foo/references/x.md': '# secret-content',
		},
	})
	const index = buildPackageSkillsIndex({
		packageId: 'pkg-1',
		kodyId,
		publishedCommit: 'abc123',
		skills,
	})
	expect(index).toMatchObject({
		version: 1,
		packageId: 'pkg-1',
		kodyId,
		publishedCommit: 'abc123',
	})
	expect(JSON.stringify(index)).not.toContain('secret-content')
	for (const resource of index.skills[0]!.resources) {
		expect('content' in resource).toBe(false)
		expect(resource.digest).toMatch(/^sha256:/)
	}
	expect(index.skills[0]!.resources.map((resource) => resource.uri)).toEqual([
		'skill://kentcdodds/ship-pr/foo/SKILL.md',
		'skill://kentcdodds/ship-pr/foo/references/x.md',
	])
})
