import { packageSkillNamePattern } from './package-skills.ts'

/** Restore exactly one skill directory, including deleted and binary files. */
export function planSkillRestore(input: {
	name: string
	current: Record<string, string>
	previous: Record<string, string>
}) {
	if (!packageSkillNamePattern.test(input.name))
		throw new Error('Invalid skill name.')
	const prefix = `skills/${input.name}/`
	const belongs = (path: string) =>
		path.startsWith(prefix) &&
		!path.split('/').some((part) => !part || part === '.' || part === '..')
	if (!Object.hasOwn(input.previous, `${prefix}SKILL.md`))
		throw new Error('This version does not contain the skill.')
	const writes = Object.entries(input.previous).filter(
		([path, content]) => belongs(path) && input.current[path] !== content,
	)
	const deletes = Object.keys(input.current).filter(
		(path) => belongs(path) && !Object.hasOwn(input.previous, path),
	)
	return { writes, deletes }
}
