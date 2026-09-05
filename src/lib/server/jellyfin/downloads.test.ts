import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../db/index.ts';
import { MOUNT_SENTINEL } from '../library/publish.ts';
import { updateSettings } from '../settings.ts';
import { updateUserSettings } from '../userSettings.ts';
import type { JellyfinClient } from './client.ts';
import { syncDownloadsPlaylist } from './downloads.ts';

let dir: string;
let media: string;
let db: DB;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'youtarr-downloads-'));
	media = path.join(dir, 'media');
	mkdirSync(media, { recursive: true });
	writeFileSync(path.join(media, MOUNT_SENTINEL), 'ok');
	process.env.MEDIA_DIR = media;
	db = openDatabase(path.join(dir, 'test.db'));
	updateSettings({ jellyfinUrl: 'http://jf:8096', jellyfinLibraryPath: '/data/media' }, db);
	updateUserSettings('u1', { downloadsPlaylist: true }, db);
	db.prepare(
		`INSERT INTO sessions (id, jellyfin_token, user_id, user_name, is_admin, created_at, expires_at)
		 VALUES ('s1', 'tok', 'u1', 'alexis', 1, ?, ?)`
	).run(Date.now(), Date.now() + 60_000);
	db.prepare(
		`INSERT INTO batches (id, kind, source_id, title, created_at, created_by)
		 VALUES ('b1', 'video', 'x', 'Some video', ?, 'u1')`
	).run(Date.now());
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.MEDIA_DIR;
});

/** Add a completed job for u1, creating its library file unless `onDisk` is false. */
function seedVideo(index: number, options: { onDisk?: boolean; batch?: string } = {}): string {
	const file = path.join(media, `Video ${index}.mp4`);
	if (options.onDisk !== false) writeFileSync(file, 'audio');
	db.prepare(
		`INSERT INTO jobs (id, batch_id, video_id, position, status, meta, output_path, finished_at)
		 VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`
	).run(
		`j${index}`,
		options.batch ?? 'b1',
		`v${index}`,
		index,
		JSON.stringify({ title: `Video ${index}` }),
		file,
		Date.now() + index
	);
	return file;
}

function clientStub(
	pathToId: Record<string, string>,
	existing: { playlistId?: string | null; items?: string[] } = {}
) {
	const created: { name: string; ids: string[] }[] = [];
	const added: string[][] = [];
	const client = {
		findVideoByPath: vi.fn(async (_t: string, _title: string, p: string) => pathToId[p] ?? null),
		findPlaylist: vi.fn(async () => existing.playlistId ?? null),
		playlistItemIds: vi.fn(async () => existing.items ?? []),
		createPlaylist: vi.fn(async (_t: string, _u: string, name: string, ids: string[]) => {
			created.push({ name, ids });
			return 'pl-new';
		}),
		addToPlaylist: vi.fn(async (_t: string, _p: string, _u: string, ids: string[]) => {
			added.push(ids);
		})
	};
	return { client: client as unknown as JellyfinClient, created, added, spies: client };
}

const jf = (name: string) => `/data/media/${name}`;

describe('syncDownloadsPlaylist', () => {
	it('does nothing when the user has not enabled it', async () => {
		updateUserSettings('u1', { downloadsPlaylist: false }, db);
		seedVideo(0);
		const { client } = clientStub({ [jf('Video 0.mp4')]: 'item-0' });
		expect(await syncDownloadsPlaylist('u1', db, { client, poll: false })).toBeNull();
	});

	it('creates the playlist from every video added so far, oldest first', async () => {
		seedVideo(0);
		seedVideo(1);
		const { client, created } = clientStub({
			[jf('Video 0.mp4')]: 'item-0',
			[jf('Video 1.mp4')]: 'item-1'
		});
		const result = await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(result).toMatchObject({ playlistId: 'pl-new', added: 2, total: 2 });
		expect(created[0]).toEqual({ name: "alexis's downloads", ids: ['item-0', 'item-1'] });
	});

	it('uses the configured playlist name when set', async () => {
		updateUserSettings('u1', { downloadsPlaylistName: 'Alexis Picks' }, db);
		seedVideo(0);
		const { client, created } = clientStub({ [jf('Video 0.mp4')]: 'item-0' });
		await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(created[0].name).toBe('Alexis Picks');
	});

	it('only adds videos that are not already in the playlist', async () => {
		seedVideo(0);
		seedVideo(1);
		const { client, added } = clientStub(
			{ [jf('Video 0.mp4')]: 'item-0', [jf('Video 1.mp4')]: 'item-1' },
			{ playlistId: 'pl-1', items: ['item-0'] }
		);
		const result = await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(result?.playlistId).toBe('pl-1');
		expect(added).toEqual([['item-1']]);
	});

	it('resolves each video once, then needs no further Jellyfin searches', async () => {
		seedVideo(0);
		const { client, spies } = clientStub(
			{ [jf('Video 0.mp4')]: 'item-0' },
			{ playlistId: 'pl-1', items: ['item-0'] }
		);
		await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(spies.findVideoByPath).toHaveBeenCalledTimes(1);
		await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(spies.findVideoByPath).toHaveBeenCalledTimes(1); // memoised in the db
	});

	it("ignores other users' videos", async () => {
		db.prepare(
			`INSERT INTO batches (id, kind, source_id, title, created_at, created_by)
			 VALUES ('b2', 'video', 'y', 'Theirs', ?, 'u2')`
		).run(Date.now());
		seedVideo(0);
		seedVideo(1, { batch: 'b2' });
		const { client, created } = clientStub({
			[jf('Video 0.mp4')]: 'item-0',
			[jf('Video 1.mp4')]: 'item-1'
		});
		await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(created[0].ids).toEqual(['item-0']);
	});

	it('cancels the job of a video whose file has been deleted, and drops it', async () => {
		seedVideo(0);
		const gone = seedVideo(1);
		const { client, created } = clientStub({
			[jf('Video 0.mp4')]: 'item-0',
			[jf('Video 1.mp4')]: 'item-1'
		});
		await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(created[0].ids).toEqual(['item-0', 'item-1']);

		rmSync(gone); // deleted from Jellyfin -> file removed from the library
		const result = await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(result?.cancelled).toBe(1);
		const row = db.prepare('SELECT status, error FROM jobs WHERE id = ?').get('j1') as {
			status: string;
			error: string;
		};
		expect(row.status).toBe('cancelled');
		expect(row.error).toBe('File is no longer in the library');
		const members = db
			.prepare('SELECT path FROM downloads_playlist_items WHERE user_id = ?')
			.all('u1') as { path: string }[];
		expect(members.map((m) => m.path)).toEqual([path.join(media, 'Video 0.mp4')]);
	});

	it('never cancels anything when the library mount is missing', async () => {
		seedVideo(0);
		rmSync(path.join(media, MOUNT_SENTINEL));
		rmSync(path.join(media, 'Video 0.mp4'));
		const { client } = clientStub({});
		expect(await syncDownloadsPlaylist('u1', db, { client, poll: false })).toBeNull();
		const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get('j0') as { status: string };
		expect(row.status).toBe('completed');
	});

	it('recreates the playlist when it has been deleted, without re-searching', async () => {
		seedVideo(0);
		const first = clientStub({ [jf('Video 0.mp4')]: 'item-0' });
		await syncDownloadsPlaylist('u1', db, { client: first.client, poll: false });
		expect(
			(
				db
					.prepare('SELECT playlist_id AS id FROM downloads_playlist WHERE user_id = ?')
					.get('u1') as {
					id: string;
				}
			).id
		).toBe('pl-new');

		// Playlist gone: fetching its items fails and a lookup by name finds nothing.
		const second = clientStub({});
		second.spies.playlistItemIds.mockRejectedValue(new Error('404'));
		const result = await syncDownloadsPlaylist('u1', db, { client: second.client, poll: false });
		expect(result).toMatchObject({ playlistId: 'pl-new', added: 1 });
		expect(second.created[0].ids).toEqual(['item-0']);
		expect(second.spies.findVideoByPath).not.toHaveBeenCalled();
	});

	it('leaves videos Jellyfin has not indexed yet for a later run', async () => {
		seedVideo(0);
		seedVideo(1);
		const { client, created } = clientStub({ [jf('Video 0.mp4')]: 'item-0' });
		const result = await syncDownloadsPlaylist('u1', db, { client, poll: false });
		expect(result).toMatchObject({ added: 1, total: 1, cancelled: 0 });
		expect(created[0].ids).toEqual(['item-0']);
		const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get('j1') as { status: string };
		expect(row.status).toBe('completed'); // not indexed != deleted
	});
});
