<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let hero = $derived(data.channel.thumbnails.at(-1)?.url ?? '');

	// Optimistic local override of the server-provided subscription state, keyed
	// by channel ref so it's ignored (and effectively reset) after navigation.
	let override = $state<{ ref: string; value: boolean } | null>(null);
	let subscribed = $derived(
		override && override.ref === data.channel.ref ? override.value : data.subscribed
	);
	let subBusy = $state(false);
	let subError = $state('');

	async function toggleSubscription() {
		subBusy = true;
		subError = '';
		const wasSubscribed = subscribed;
		try {
			const response = await fetch('/api/subscriptions', {
				method: wasSubscribed ? 'DELETE' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ channelRef: data.channel.ref })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.error ?? `request failed (${response.status})`);
			}
			override = { ref: data.channel.ref, value: !wasSubscribed };
		} catch (cause) {
			subError = (cause as Error).message;
		} finally {
			subBusy = false;
		}
	}

	let videoState = $state<Record<string, 'working' | 'queued' | 'error'>>({});

	async function downloadVideo(videoId: string) {
		videoState = { ...videoState, [videoId]: 'working' };
		try {
			const response = await fetch('/api/queue', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'video', videoId })
			});
			if (!response.ok) throw new Error();
			videoState = { ...videoState, [videoId]: 'queued' };
		} catch {
			videoState = { ...videoState, [videoId]: 'error' };
		}
	}
</script>

<svelte:head>
	<title>{data.channel.name} - youtarr</title>
</svelte:head>

<header class="mb-8 flex flex-col items-start gap-6 sm:flex-row sm:items-end">
	{#if hero}
		<img src={hero} alt="" class="h-40 w-40 rounded-full object-cover bg-surface-3 shadow-lg" />
	{/if}
	<div class="min-w-0">
		<p class="text-xs uppercase tracking-wide text-ink-faint">Channel</p>
		<h1 class="mt-1 text-4xl font-bold tracking-tight">{data.channel.name}</h1>
		<div class="mt-4 flex flex-wrap items-center gap-3">
			<button
				onclick={toggleSubscription}
				disabled={subBusy}
				class="rounded-full px-5 py-2 text-sm font-medium transition disabled:opacity-50
					{subscribed
					? 'border border-line bg-surface-2 text-ink hover:bg-surface-3'
					: 'bg-accent text-accent-ink hover:bg-accent-hover'}"
				title="Automatically download new uploads from this channel (checked daily)"
			>
				{#if subBusy}
					Working…
				{:else if subscribed}
					Following ✓
				{:else}
					Follow for new uploads
				{/if}
			</button>
			{#if subscribed && !subBusy}
				<span class="text-xs text-ink-faint">New uploads download automatically</span>
			{/if}
			{#if subError}
				<span class="text-sm text-accent-hover" role="alert">{subError}</span>
			{/if}
		</div>
	</div>
</header>

{#if data.channel.videos.length > 0}
	<section>
		<h2 class="mb-3 text-lg font-semibold">Uploads</h2>
		<ul class="divide-y divide-line overflow-hidden rounded-xl bg-surface">
			{#each data.channel.videos as video (video.videoId)}
				<li class="group flex items-center gap-4 px-4 py-2.5 transition hover:bg-surface-2">
					<a href="/video/{video.videoId}" class="flex min-w-0 flex-1 items-center gap-4">
						<img
							src={video.thumbnails.at(-1)?.url}
							alt=""
							loading="lazy"
							class="h-14 w-24 rounded object-cover bg-surface-3"
						/>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm text-ink">{video.title}</p>
							<p class="truncate text-xs text-ink-muted">{video.duration ?? ''}</p>
						</div>
					</a>
					<button
						onclick={() => downloadVideo(video.videoId)}
						disabled={videoState[video.videoId] === 'working' || video.isDownloaded}
						class="shrink-0 rounded-full px-3 py-1 text-xs transition disabled:opacity-50
							{video.isDownloaded || videoState[video.videoId] === 'queued'
							? 'text-ok'
							: 'text-ink-muted hover:bg-surface-3 hover:text-ink'}"
					>
						{#if video.isDownloaded || videoState[video.videoId] === 'queued'}
							Downloaded ✓
						{:else if videoState[video.videoId] === 'working'}
							Queuing…
						{:else if videoState[video.videoId] === 'error'}
							Failed
						{:else}
							Download
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	</section>
{:else}
	<p class="mt-16 text-center text-ink-muted">No uploads found for this channel.</p>
{/if}
