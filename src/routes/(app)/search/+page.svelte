<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.query ? `${data.query} - search` : 'Search'} - youtarr</title>
</svelte:head>

{#if data.query}
	{#if data.results.length === 0}
		<p class="mt-16 text-center text-ink-muted">Nothing found for “{data.query}”.</p>
	{:else}
		<ul class="divide-y divide-line overflow-hidden rounded-xl bg-surface">
			{#each data.results as video (video.videoId)}
				<li class="flex items-center gap-4 px-4 py-2.5 transition hover:bg-surface-2">
					<img
						src={video.thumbnails.at(-1)?.url}
						alt=""
						loading="lazy"
						class="h-14 w-24 rounded object-cover bg-surface-3"
					/>
					<div class="min-w-0 flex-1">
						<a href="/video/{video.videoId}" class="block truncate text-sm text-ink hover:underline"
							>{video.title}</a
						>
						<p class="truncate text-xs text-ink-muted">{video.channel.name}</p>
					</div>
					{#if video.isDownloaded}
						<span
							class="flex items-center gap-1 text-xs text-ok bg-ok/10 rounded-full px-2 py-0.5"
							title="Downloaded"
						>
							<svg viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true">
								<path
									fill-rule="evenodd"
									d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 0 1 1.4-1.4l3.8 3.79 6.8-6.8a1 1 0 0 1 1.4 0Z"
									clip-rule="evenodd"
								/>
							</svg>
							Downloaded
						</span>
					{/if}
					<span class="text-xs text-ink-faint">{video.duration ?? ''}</span>
					{#if video.channel.id}
						<a
							href="/channel/channel/{video.channel.id}"
							class="rounded-full px-3 py-1 text-xs text-ink-muted transition hover:bg-surface-3 hover:text-ink"
						>
							View channel
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{:else}
	<p class="mt-16 text-center text-ink-muted">Type something in the search bar to get started.</p>
{/if}
