/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type ProfilePackageFilters } from '#universal/community-public-types.ts'
import { buildProfileHref } from '#universal/profile-search.ts'
import { inputCss } from '#universal/styles/style-primitives.ts'

export function ProfileRepositorySearchInput({
	username,
	basePath,
	filters,
}: {
	username: string
	basePath?: string
	filters: ProfilePackageFilters
}) {
	const [query, setQuery] = useState(filters.query)
	const navigate = useNavigate()
	const href = useMatchedPageScope().pageLocation.href
	const [previousQuery, setPreviousQuery] = useState(filters.query)
	if (previousQuery !== filters.query) {
		setPreviousQuery(filters.query)
		setQuery(filters.query)
	}
	return (
		<input
			type="text"
			role="searchbox"
			inputMode="search"
			autoComplete="off"
			autoCorrect="off"
			spellCheck={false}
			name="q"
			data-testid="profile-repository-search"
			value={query}
			placeholder="Search by name, description, or tags"
			css={inputCss}
			onChange={(event) => {
				const value = event.currentTarget.value
				setQuery(value)
				const to = buildProfileHref({
					basePath,
					username,
					...filters,
					query: value,
					extraSearchParams: new URL(href, 'https://kody.local').searchParams,
				})
				void navigate({ to, replace: true, resetScroll: false })
			}}
		/>
	)
}
