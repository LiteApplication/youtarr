<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let checking = $state(false);
	let checkResult = $state('');
	let busyId = $state('');

	function lastChecked(ms: number | null): string {
		if (!ms) return 'not yet checked';
		return `checked ${new Date(ms).toLocaleString()}`;
	}

	async function checkNow() {
		checking = true;
		checkResult = '';
		try {
			const response = await fetch('/api/subscriptions/check', { method: 'POST' });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
			checkResult =
				body.enqueued > 0
					? `Queued ${body.enqueued} new upload batch${body.enqueued === 1 ? '' : 'es'}.`
					: 'No new uploads found.';
			await invalidateAll();
		} catch (cause) {
			checkResult = (cause as Error).message;
		} finally {
			checking = false;
		}
	}

	async function unfollow(channelRef: string) {
		busyId = channelRef;
		try {
			await fetch('/api/subscriptions', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ channelRef })
			});
			await invalidateAll();
		} finally {
			busyId = '';
		}
	}
</script>

<svelte:head>
	<title>Subscriptions - youtarr</title>
</svelte:head>

<header class="mb-6 flex flex-wrap items-end justify-between gap-4">
	<div>
		<h1 class="text-3xl font-bold tracking-tight">Subscriptions</h1>
		<p class="mt-1 text-sm text-ink-muted">
			{#if data.enabled}
				New uploads from followed channels download automatically, checked about every
				{data.checkHours} hour{data.checkHours === 1 ? '' : 's'}.
			{:else}
				Auto-download is <span class="text-accent-hover">disabled</span> in settings — followed channels
				won't be checked.
			{/if}
		</p>
	</div>
	<button
		onclick={checkNow}
		disabled={checking || data.subscriptions.length === 0}
		class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-50"
	>
		{checking ? 'Checking…' : 'Check now'}
	</button>
</header>

{#if checkResult}
	<p class="mb-4 text-sm text-ink-muted" role="status">{checkResult}</p>
{/if}

{#if data.subscriptions.length === 0}
	<p class="mt-16 text-center text-ink-muted">
		You aren't following any channels yet. Open a channel and choose
		<span class="text-ink">Follow for new uploads</span>.
	</p>
{:else}
	<ul class="divide-y divide-line overflow-hidden rounded-xl bg-surface">
		{#each data.subscriptions as sub (sub.channelRef)}
			<li class="flex items-center gap-4 px-4 py-3">
				<a href="/channel/{sub.channelRef}" class="shrink-0">
					{#if sub.thumbnail}
						<img
							src={sub.thumbnail}
							alt=""
							class="h-12 w-12 rounded-full bg-surface-3 object-cover"
						/>
					{:else}
						<div class="h-12 w-12 rounded-full bg-surface-3"></div>
					{/if}
				</a>
				<div class="min-w-0 flex-1">
					<a href="/channel/{sub.channelRef}" class="truncate font-medium hover:underline">
						{sub.name}
					</a>
					<p class="truncate text-xs text-ink-faint">{lastChecked(sub.lastCheckedAt)}</p>
				</div>
				<button
					onclick={() => unfollow(sub.channelRef)}
					disabled={busyId === sub.channelRef}
					class="rounded-full border border-line px-4 py-1.5 text-sm text-ink-muted transition hover:bg-surface-2 hover:text-ink disabled:opacity-50"
				>
					{busyId === sub.channelRef ? '…' : 'Unfollow'}
				</button>
			</li>
		{/each}
	</ul>
{/if}
