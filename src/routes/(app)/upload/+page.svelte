<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);

	const fields = [
		{ name: 'title', label: 'Title', required: true, type: 'text' },
		{ name: 'channel', label: 'Channel', required: true, type: 'text' },
		{ name: 'season', label: 'Season', required: true, type: 'text' },
		{ name: 'episode', label: 'Episode #', required: true, type: 'number' },
		{ name: 'aired', label: 'Upload date', required: false, type: 'date' }
	];
</script>

<svelte:head>
	<title>Upload - youtarr</title>
</svelte:head>

<div class="mx-auto max-w-xl">
	<h1 class="text-3xl font-bold">Upload video</h1>
	<p class="mt-1 text-sm text-ink-muted">
		Add your own files to the library. They are filed by the naming template and given NFOs -
		exactly like downloaded videos.
	</p>

	<form
		method="POST"
		enctype="multipart/form-data"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
		class="mt-6 space-y-4 rounded-2xl bg-surface p-6"
	>
		<label class="block">
			<span class="mb-1 block text-sm text-ink-muted">Video file (mp4, mkv, webm, m4v, avi)</span>
			<input
				name="file"
				type="file"
				required
				accept=".mp4,.mkv,.webm,.m4v,.avi,video/*"
				class="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-surface-3 file:px-4 file:py-1.5 file:text-ink-muted"
			/>
		</label>

		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			{#each fields as field (field.name)}
				<label class="block {field.name === 'title' ? 'sm:col-span-2' : ''}">
					<span class="mb-1 block text-sm text-ink-muted">{field.label}</span>
					<input
						name={field.name}
						type={field.type}
						required={field.required}
						class="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink focus:border-accent"
					/>
				</label>
			{/each}
		</div>

		{#if form?.error}
			<p class="rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger" role="alert">{form.error}</p>
		{/if}

		<button
			type="submit"
			disabled={submitting}
			class="rounded-full bg-accent px-6 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-50"
		>
			{submitting ? 'Uploading…' : 'Upload to library'}
		</button>
	</form>
</div>
