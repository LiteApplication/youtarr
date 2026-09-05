<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);

	let fields = $derived([
		{ name: 'title', label: 'Title', value: data.tags.title, required: true, type: 'text' },
		{ name: 'channel', label: 'Channel', value: data.tags.showTitle, required: true, type: 'text' },
		{ name: 'season', label: 'Season', value: data.tags.season, required: true, type: 'text' },
		{
			name: 'episode',
			label: 'Episode #',
			value: data.tags.episode?.toString(),
			required: true,
			type: 'number'
		},
		{ name: 'aired', label: 'Upload date', value: data.tags.aired, required: false, type: 'date' }
	]);
</script>

<svelte:head>
	<title>Edit metadata - youtarr</title>
</svelte:head>

<div class="mx-auto max-w-xl">
	<h1 class="text-3xl font-bold">Edit metadata</h1>
	<p class="mt-1 truncate text-sm text-ink-muted">{data.path}</p>

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
		class="mt-6 space-y-4 rounded-2xl bg-surface p-6"
	>
		<input type="hidden" name="path" value={data.path} />
		{#each fields as field (field.name)}
			<label class="block">
				<span class="mb-1 block text-sm text-ink-muted">{field.label}</span>
				<input
					name={field.name}
					type={field.type}
					required={field.required}
					value={field.value ?? ''}
					class="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink focus:border-accent"
				/>
			</label>
		{/each}

		{#if form?.error}
			<p class="rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger" role="alert">{form.error}</p>
		{/if}

		<p class="text-xs text-ink-faint">
			Saving moves the file to match the naming template if needed, and rewrites the episode and
			show NFOs Jellyfin reads.
		</p>

		<div class="flex gap-3">
			<button
				type="submit"
				disabled={submitting}
				class="rounded-full bg-accent px-6 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-50"
			>
				{submitting ? 'Saving…' : 'Save'}
			</button>
			<a
				href="/library"
				class="rounded-full bg-surface-2 px-6 py-2 text-sm text-ink-muted transition hover:bg-surface-3 hover:text-ink"
			>
				Cancel
			</a>
		</div>
	</form>
</div>
