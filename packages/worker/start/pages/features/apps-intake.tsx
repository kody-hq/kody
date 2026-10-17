/** @jsxImportSource @emotion/react */
export type Brief = {
	id: number
	name: string
	kind: string
	deadline: string
	copy: string
}
export function AppsIntake(props: {
	draft: Brief
	onChange: (brief: Brief) => void
	onSave: () => void
}) {
	const { draft } = props
	return (
		<form
			className="pw-apx-form"
			onSubmit={(event) => {
				event.preventDefault()
				props.onSave()
			}}
		>
			<h3>Project intake</h3>
			<p>
				<label>
					Project name
					<br />
					<input
						required
						pattern={String.raw`.*\S.*`}
						title="Enter a project name."
						value={draft.name}
						onChange={(event) => {
							props.onChange({
								...draft,
								name: event.currentTarget.value,
							})
						}}
					/>
				</label>
			</p>
			<p>
				<label>
					Job type
					<br />
					<select
						value={draft.kind}
						onChange={(event) => {
							props.onChange({
								...draft,
								kind: event.currentTarget.value,
							})
						}}
					>
						{['Website', 'Campaign', 'Internal tool'].map((kind) => (
							<option key={kind}>{kind}</option>
						))}
					</select>
				</label>
			</p>
			<p>
				<label>
					Deadline
					<br />
					<select
						value={draft.deadline}
						onChange={(event) => {
							props.onChange({
								...draft,
								deadline: event.currentTarget.value,
							})
						}}
					>
						{['October 28', 'November 4', 'No deadline'].map((date) => (
							<option key={date}>{date}</option>
						))}
					</select>
				</label>
			</p>
			<p>
				<label>
					Brief
					<br />
					<textarea
						value={draft.copy}
						onChange={(event) => {
							props.onChange({
								...draft,
								copy: event.currentTarget.value,
							})
						}}
					/>
				</label>
			</p>
			<button className="run" type="submit">
				Save brief
			</button>
		</form>
	)
}
