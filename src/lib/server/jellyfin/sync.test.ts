import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../db/index.ts';
import { updateSettings } from '../settings.ts';
import type { JellyfinClient } from './client.ts';
import { syncPlaylistBatch, toJellyfinPath } from './sync.ts';

let dir: string;
let db: DB;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'youtarr-sync-'));
	db = openDatabase(path.join(dir, 'test.db'));
	updateSettings({ jellyfinUrl: 'http://jf:8096', jellyfinLibraryPath: '/data/media' }, db);
	db.prepare(
		`INSERT INTO sessions (id, jellyfin_token, user_id, user_name, is_admin, created_at, expires_at)
		 VALUES ('s1', 'tok', 'u1', 'alexis', 1, ?, ?)`
	).run(Date.now(), Date.now() + 60_000);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.MEDIA_DIR;
});

function seedPlaylistBatch(statuses: ('completed' | 'failed')[]): string {
	db.prepare(
		`INSERT INTO batches (id, kind, source_id, title, created_at, created_by)
		 VALUES ('b1', 'playlist', 'VL1', 'My Mix', ?, 'u1')`
	).run(Date.now());
	statuses.forEach((status, index) => {
		db.prepare(
			`INSERT INTO jobs (id, batch_id, video_id, position, status, meta, output_path)
			 VALUES (?, 'b1', ?, ?, ?, ?, ?)`
		).run(
			`j${index}`,
			`v${index}`,
			index,
			status,
			JSON.stringify({ title: `Video ${index}`, channel: 'A' }),
			status === 'completed'
				? `/media/A/Season 2023/A - S2023E00${index + 1} - Video ${index}.mp4`
				: null
		);
	});
	return 'b1';
}

describe('toJellyfinPath', () => {
	it('translates the youtarr mount into the Jellyfin library path', () => {
		expect(toJellyfinPath('/media/Channel/Season 2023/01 - X.mp4', '/data/media', '/media')).toBe(
			'/data/media/Channel/Season 2023/01 - X.mp4'
		);
	});
});

describe('syncPlaylistBatch', () => {
	function clientStub(
		pathToId: Record<string, string>,
		existingPlaylist: string | null = null,
		existingItems: string[] = []
	) {
		const created: { name: string; ids: string[] }[] = [];
		const added: string[][] = [];
		const client = {
			findVideoByPath: vi.fn(async (_t: string, _title: string, p: string) => pathToId[p] ?? null),
			findPlaylist: vi.fn(async () => existingPlaylist),
			playlistItemIds: vi.fn(async () => existingItems),
			createPlaylist: vi.fn(async (_t: string, _u: string, name: string, ids: string[]) => {
				created.push({ name, ids });
				return 'pl-new';
			}),
			addToPlaylist: vi.fn(async (_t: string, _p: string, _u: string, ids: string[]) => {
				added.push(ids);
			})
		};
		return { client: client as unknown as JellyfinClient, created, added };
	}

	it('creates a playlist from resolved item ids in playlist order', async () => {
		const batchId = seedPlaylistBatch(['completed', 'completed']);
		process.env.MEDIA_DIR = '/media';
		const { client, created } = clientStub({
			'/data/media/A/Season 2023/A - S2023E001 - Video 0.mp4': 'item-0',
			'/data/media/A/Season 2023/A - S2023E002 - Video 1.mp4': 'item-1'
		});
		const result = await syncPlaylistBatch(batchId, db, { client, pollIntervalMs: 1 });
		expect(result).toEqual({ playlistId: 'pl-new', matched: 2, total: 2 });
		expect(created[0]).toEqual({ name: 'My Mix', ids: ['item-0', 'item-1'] });
	});

	it('extends an existing playlist instead of duplicating it', async () => {
		const batchId = seedPlaylistBatch(['completed']);
		process.env.MEDIA_DIR = '/media';
		const { client, added } = clientStub(
			{ '/data/media/A/Season 2023/A - S2023E001 - Video 0.mp4': 'item-0' },
			'pl-existing'
		);
		const result = await syncPlaylistBatch(batchId, db, { client, pollIntervalMs: 1 });
		expect(result?.playlistId).toBe('pl-existing');
		expect(added[0]).toEqual(['item-0']);
	});

	it('does not re-add videos already in the playlist (idempotent)', async () => {
		const batchId = seedPlaylistBatch(['completed', 'completed']);
		process.env.MEDIA_DIR = '/media';
		const { client, added } = clientStub(
			{
				'/data/media/A/Season 2023/A - S2023E001 - Video 0.mp4': 'item-0',
				'/data/media/A/Season 2023/A - S2023E002 - Video 1.mp4': 'item-1'
			},
			'pl-existing',
			['item-0'] // item-0 is already in the playlist
		);
		const result = await syncPlaylistBatch(batchId, db, { client, pollIntervalMs: 1 });
		expect(result?.playlistId).toBe('pl-existing');
		expect(added[0]).toEqual(['item-1']); // only the missing one
	});

	it('persists the resolved playlist id onto the batch', async () => {
		const batchId = seedPlaylistBatch(['completed']);
		process.env.MEDIA_DIR = '/media';
		const { client } = clientStub({
			'/data/media/A/Season 2023/A - S2023E001 - Video 0.mp4': 'item-0'
		});
		await syncPlaylistBatch(batchId, db, { client, pollIntervalMs: 1 });
		const row = db
			.prepare('SELECT jellyfin_playlist_id AS id FROM batches WHERE id = ?')
			.get(batchId) as { id: string | null };
		expect(row.id).toBe('pl-new');
	});

	it('with poll:false makes a single pass and adds only what is already scanned', async () => {
		const batchId = seedPlaylistBatch(['completed', 'completed']);
		process.env.MEDIA_DIR = '/media';
		// Only the first video has been indexed by Jellyfin so far.
		const { client, created } = clientStub({
			'/data/media/A/Season 2023/A - S2023E001 - Video 0.mp4': 'item-0'
		});
		const result = await syncPlaylistBatch(batchId, db, {
			client,
			pollIntervalMs: 1000,
			poll: false
		});
		// A single pass, no long retry wait: only the scanned video is added.
		expect(result).toEqual({ playlistId: 'pl-new', matched: 1, total: 2 });
		expect(created[0].ids).toEqual(['item-0']);
	});

	it('skips failed videos but still creates the playlist from the rest', async () => {
		const batchId = seedPlaylistBatch(['completed', 'failed']);
		process.env.MEDIA_DIR = '/media';
		const { client, created } = clientStub({
			'/data/media/A/Season 2023/A - S2023E001 - Video 0.mp4': 'item-0'
		});
		const result = await syncPlaylistBatch(batchId, db, { client, pollIntervalMs: 1 });
		expect(result).toEqual({ playlistId: 'pl-new', matched: 1, total: 1 });
		expect(created[0].ids).toEqual(['item-0']);
	});

	it('ignores non-playlist batches', async () => {
		db.prepare(
			`INSERT INTO batches (id, kind, source_id, title, created_at, created_by)
			 VALUES ('b2', 'channel', 'x', 'Channel', ?, 'u1')`
		).run(Date.now());
		const { client } = clientStub({});
		expect(await syncPlaylistBatch('b2', db, { client, pollIntervalMs: 1 })).toBeNull();
	});
});
