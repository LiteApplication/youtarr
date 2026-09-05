import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.ts';
import type { ChannelDetail, VideoResult } from '../ytdlp/metadata.ts';
import { checkDueSubscriptions, checkSubscription, type CheckDeps } from './check.ts';
import {
	dueSubscriptions,
	isSubscribed,
	listSubscriptions,
	seenVideoIds,
	subscribe,
	unsubscribe
} from './store.ts';

let dir: string;
let db: DB;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'youtarr-subs-'));
	db = openDatabase(path.join(dir, 'test.db'));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

const CHANNEL_REF = '@testchannel';
const CHANNEL_ID = 'UCartist000000000000000';

function video(id: string): VideoResult {
	return {
		kind: 'video',
		videoId: id,
		title: id,
		channel: { name: 'Test Channel', id: CHANNEL_ID },
		thumbnails: []
	};
}

/** Injectable check deps from an upload list. */
function deps(videoIds: string[]): CheckDeps {
	return {
		getChannel: async (): Promise<ChannelDetail> => ({
			channelId: CHANNEL_ID,
			ref: CHANNEL_REF,
			name: 'Test Channel',
			thumbnails: [],
			videos: videoIds.map(video)
		})
	};
}

function sub() {
	return subscribe(
		{
			channelRef: CHANNEL_REF,
			channelId: CHANNEL_ID,
			name: 'Test Channel',
			thumbnail: null,
			createdBy: 'user1'
		},
		['v_a', 'v_b'], // baseline uploads seeded
		db
	);
}

describe('subscription store', () => {
	it('subscribes, seeds the seen-set, and reports membership', () => {
		sub();
		expect(isSubscribed(CHANNEL_REF, 'user1', db)).toBe(true);
		expect(listSubscriptions('user1', db)).toHaveLength(1);
		expect(seenVideoIds(CHANNEL_REF, 'user1', db)).toEqual(new Set(['v_a', 'v_b']));
	});

	it('re-subscribing tops up the seen-set without duplicating', () => {
		sub();
		subscribe(
			{
				channelRef: CHANNEL_REF,
				channelId: CHANNEL_ID,
				name: 'Renamed',
				thumbnail: 'x',
				createdBy: 'user1'
			},
			['v_b', 'v_c'],
			db
		);
		expect(listSubscriptions('user1', db)).toHaveLength(1);
		expect(listSubscriptions('user1', db)[0].name).toBe('Renamed');
		expect(seenVideoIds(CHANNEL_REF, 'user1', db)).toEqual(new Set(['v_a', 'v_b', 'v_c']));
	});

	it('unsubscribe cascades the seen-set away', () => {
		sub();
		expect(unsubscribe(CHANNEL_REF, 'user1', db)).toBe(true);
		expect(isSubscribed(CHANNEL_REF, 'user1', db)).toBe(false);
		expect(seenVideoIds(CHANNEL_REF, 'user1', db).size).toBe(0);
	});

	it('due list respects the interval and last-checked time', () => {
		sub(); // last_checked_at is null → always due
		expect(dueSubscriptions(24 * 3600_000, db)).toHaveLength(1);
	});

	it('keeps two users following the same channel independent', () => {
		subscribe(
			{
				channelRef: CHANNEL_REF,
				channelId: CHANNEL_ID,
				name: 'Test Channel',
				thumbnail: null,
				createdBy: 'user1'
			},
			['v_a'],
			db
		);
		subscribe(
			{
				channelRef: CHANNEL_REF,
				channelId: CHANNEL_ID,
				name: 'Test Channel',
				thumbnail: null,
				createdBy: 'user2'
			},
			['v_z'],
			db
		);
		// Each user sees only their own subscription with their own seen-set.
		expect(listSubscriptions('user1', db)).toHaveLength(1);
		expect(listSubscriptions('user2', db)).toHaveLength(1);
		expect(seenVideoIds(CHANNEL_REF, 'user1', db)).toEqual(new Set(['v_a']));
		expect(seenVideoIds(CHANNEL_REF, 'user2', db)).toEqual(new Set(['v_z']));
		// One unsubscribing leaves the other intact.
		unsubscribe(CHANNEL_REF, 'user1', db);
		expect(isSubscribed(CHANNEL_REF, 'user1', db)).toBe(false);
		expect(isSubscribed(CHANNEL_REF, 'user2', db)).toBe(true);
		expect(seenVideoIds(CHANNEL_REF, 'user2', db)).toEqual(new Set(['v_z']));
	});
});

describe('checkSubscription', () => {
	it('enqueues only uploads not already seen, then marks them seen', async () => {
		sub(); // seen: v_a, v_b
		const result = await checkSubscription(
			listSubscriptions('user1', db)[0],
			db,
			deps(['v_a', 'v_b', 'v_new'])
		);

		expect(result.enqueued).toBe(1);
		expect(seenVideoIds(CHANNEL_REF, 'user1', db).has('v_new')).toBe(true);
		// last_checked_at is now set.
		expect(listSubscriptions('user1', db)[0].lastCheckedAt).not.toBeNull();

		const batch = db.prepare("SELECT id, title FROM batches WHERE kind = 'channel'").get() as {
			id: string;
			title: string;
		};
		expect(batch.title).toBe('Test Channel - new uploads');
		const jobs = db.prepare('SELECT video_id FROM jobs WHERE batch_id = ?').all(batch.id) as {
			video_id: string;
		}[];
		expect(jobs.map((j) => j.video_id)).toEqual(['v_new']);
	});

	it('is a no-op on the second run when nothing new appeared', async () => {
		sub();
		await checkSubscription(listSubscriptions('user1', db)[0], db, deps(['v_a', 'v_b', 'v_new']));

		const result = await checkSubscription(
			listSubscriptions('user1', db)[0],
			db,
			deps(['v_a', 'v_b', 'v_new'])
		);
		expect(result.enqueued).toBe(0);
	});
});

describe('checkDueSubscriptions', () => {
	it('checks every due subscription and aggregates enqueued batches', async () => {
		sub();
		const result = await checkDueSubscriptions(0, db, deps(['v_a', 'v_b', 'v_new']));
		expect(result.enqueued).toBe(1);
		expect(result.batchIds).toHaveLength(1);
	});
});
