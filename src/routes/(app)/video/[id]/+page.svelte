<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let cover = $derived(data.video.thumbnails.at(-1)?.url ?? '');
	let queueState = $state<'idle' | 'working' | 'queued' | 'error'>('idle');
	let queueError = $state('');
	let deleteState = $state<'idle' | 'working' | 'done' | 'error'>('idle');
	let isDownloaded = $state(data.isDownloaded);

	async function download() {
		queueState = 'working';
		queueError = '';
		try {
			const response = await fetch('/api/queue', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'video', videoId: data.video.videoId })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.error ?? `queue responded ${response.status}`);
			}
			queueState = 'queued';
		} catch (cause) {
			queueState = 'error';
			queueError = (cause as Error).message;
		}
	}
</script>

<svelte:head>
	<title>{data.video.title} - youtarr</title>
</svelte:head>

<header class="mb-8 flex flex-col items-start gap-6 sm:flex-row sm:items-end">
	{#if cover}
		<img
			src={cover}
			alt=""
			class="aspect-video w-full rounded-lg bg-surface-3 object-cover shadow-lg sm:w-80"
		/>
	{/if}
	<div class="min-w-0">
		<p class="text-xs uppercase tracking-wide text-ink-faint">Video</p>
		<h1 class="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{data.video.title}</h1>
		<p class="mt-2 text-sm text-ink-muted">
			{#if data.video.channel.id}
				<a href="/channel/channel/{data.video.channel.id}" class="hover:text-ink hover:underline"
					>{data.video.channel.name}</a
				>
			{:else}
				{data.video.channel.name}
			{/if}
			{#if data.video.duration}&nbsp;·&nbsp;{data.video.duration}{/if}
		</p>
		<div class="mt-4 flex flex-wrap items-center gap-3">
			{#if isDownloaded && queueState === 'idle'}
				<!-- Downloaded → hover becomes Delete -->
				<form
					method="POST"
					action="?/delete"
					use:enhance={() => {
						deleteState = 'working';
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') {
								isDownloaded = false;
								deleteState = 'done';
							} else {
								deleteState = 'error';
							}
						};
					}}
				>
					<input type="hidden" name="outputPath" value={data.outputPath} />
					<button
						type="submit"
						disabled={deleteState === 'working'}
						class="group/del relative rounded-full border px-6 py-2 text-sm font-medium transition disabled:opacity-50
							border-ok bg-ok/15 text-ok hover:border-danger hover:bg-danger/15 hover:text-danger"
						title="Delete from library"
					>
						<span class="group-hover/del:hidden">
							{deleteState === 'working' ? 'Deleting…' : 'Downloaded ✓'}
						</span>
						<span class="hidden group-hover/del:inline">Delete video</span>
					</button>
				</form>
			{:else}
				<button
					onclick={download}
					disabled={queueState === 'working'}
					class="rounded-full px-6 py-2 text-sm font-medium transition disabled:opacity-50 bg-accent text-accent-ink hover:bg-accent-hover"
				>
					{queueState === 'working'
						? 'Queuing…'
						: queueState === 'queued'
							? 'Queued ✓'
							: 'Download video'}
				</button>
			{/if}
			{#if queueState === 'error'}
				<span class="text-sm text-danger" role="alert">{queueError}</span>
			{/if}
			{#if deleteState === 'error'}
				<span class="text-sm text-danger" role="alert">Delete failed</span>
			{/if}
		</div>
	</div>
</header>

{#if data.video.description}
	<section class="max-w-3xl">
		<h2 class="mb-2 text-lg font-semibold">Description</h2>
		<p class="whitespace-pre-line text-sm text-ink-muted">{data.video.description}</p>
	</section>
{/if}
