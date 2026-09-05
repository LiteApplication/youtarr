import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.ts';
import { createSentinel } from '../library/publish.ts';
import { claimNextJob, createBatch, listQueue } from '../queue/store.ts';
import { WorkerPool } from '../queue/worker.ts';
import { YtdlpPipeline } from './runner.ts';

const HERE = import.meta.dirname;
// fake_ytdlp.py only uses the stdlib (no mutagen/tagging step exists anymore),
// so plain python3 on PATH is enough - no venv needed.
const PYTHON = 'python3';
// Per-file fixture path: test files run in parallel workers, so a shared name
// would let one worker read the fixture while another is mid-ffmpeg-write.
const FIXTURE = path.join(tmpdir(), 'youtarr-fixture-pipeline.mp4');

// Wrapper so the pipeline can spawn "yt-dlp" as a single binary path.
let fakeBin: string;

beforeAll(() => {
	if (!existsSync(FIXTURE)) {
		// 1 second of a solid-color frame - a real, playable MP4 file.
		execFileSync('ffmpeg', [
			'-y',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'color=c=blue:size=64x64:duration=1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			FIXTURE
		]);
	}
	fakeBin = path.join(tmpdir(), 'youtarr-fake-ytdlp.sh');
	execFileSync('bash', [
		'-c',
		`printf '#!/bin/bash\\nexec "${PYTHON}" "${HERE}/fake_ytdlp.py" "$@"\\n' > ${fakeBin} && chmod +x ${fakeBin}`
	]);
});

let dir: string;
let db: DB;
let library: string;
let scratch: string;
let staging: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'youtarr-pipe-'));
	db = openDatabase(path.join(dir, 'test.db'));
	library = path.join(dir, 'media');
	scratch = path.join(dir, 'scratch');
	staging = path.join(library, '.youtarr-staging');
	mkdirSync(library, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	createSentinel(library);
	process.env.FAKE_YTDLP_FIXTURE = FIXTURE;
	process.env.FAKE_YTDLP_MODE = 'ok';
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function pipeline(): YtdlpPipeline {
	return new YtdlpPipeline({
		db,
		ytdlpBin: fakeBin,
		libraryRoot: library,
		staging,
		scratchRoot: scratch,
		fetchImpl: (async () => new Response('nope', { status: 404 })) as typeof fetch
	});
}

function seedChannel() {
	return createBatch(
		{
			kind: 'channel',
			sourceId: 'UC123',
			title: 'My Channel',
			channel: 'My Channel',
			createdBy: 'u'
		},
		[
			{
				videoId: 'IluRBvnYMoY',
				meta: {
					title: 'One More Time',
					channel: 'My Channel',
					channelId: 'UC123',
					uploadDate: '20230101'
				}
			},
			{
				videoId: 'FGBhQbmPwH8',
				meta: {
					title: 'Aerodynamic <live> & loud',
					channel: 'My Channel',
					channelId: 'UC123',
					uploadDate: '20230102'
				}
			}
		],
		db
	);
}

describe('full pipeline', () => {
	it('downloads, publishes, and writes NFOs end to end', async () => {
		const { batch } = seedChannel();
		// concurrency 1 keeps episode-number assignment order deterministic.
		const pool = new WorkerPool(pipeline(), { db, concurrency: () => 1, maxRetries: () => 0 });
		pool.start();
		const start = Date.now();
		while (listQueue('u', db)[0].jobs.some((j) => !['completed', 'failed'].includes(j.status))) {
			if (Date.now() - start > 30_000) throw new Error('pipeline timeout');
			await new Promise((r) => setTimeout(r, 50));
		}
		await pool.stop();

		const jobs = listQueue('u', db)[0].jobs;
		expect(jobs.map((j) => j.status)).toEqual(['completed', 'completed']);

		const seasonDir = path.join(library, 'My Channel', 'Season 2023');
		expect(existsSync(path.join(seasonDir, 'My Channel - S2023E001 - One More Time.mp4'))).toBe(
			true
		);
		// XML-hostile title survived sanitisation into a safe filename…
		expect(
			existsSync(path.join(seasonDir, 'My Channel - S2023E002 - Aerodynamic _live_ & loud.mp4'))
		).toBe(true);

		// …and was escaped inside the NFO.
		const nfo = readFileSync(
			path.join(seasonDir, 'My Channel - S2023E002 - Aerodynamic _live_ & loud.nfo'),
			'utf8'
		);
		expect(nfo).toContain('Aerodynamic &lt;live&gt; &amp; loud');
		expect(nfo).toContain('<season>2023</season>');
		expect(existsSync(path.join(library, 'My Channel', 'tvshow.nfo'))).toBe(true);

		// Scratch and staging fully cleaned.
		expect(existsSync(path.join(staging, jobs[0].id))).toBe(false);
		expect(existsSync(path.join(scratch, jobs[0].id))).toBe(false);

		expect(batch.id).toBeTruthy();
	}, 40_000);

	it('classifies permanent failures without retrying', async () => {
		process.env.FAKE_YTDLP_MODE = 'fail-permanent';
		seedChannel();
		const job = claimNextJob(db)!;
		const failure = await pipeline()
			.run(job, () => {}, new AbortController().signal)
			.then(
				() => null,
				(cause: Error & { retryable?: boolean }) => cause
			);
		expect(failure?.message).toMatch(/Video unavailable/);
		expect(failure?.retryable).toBeUndefined();
	});

	it('classifies transient failures as retryable', async () => {
		process.env.FAKE_YTDLP_MODE = 'fail-transient';
		seedChannel();
		const job = claimNextJob(db)!;
		await expect(pipeline().run(job, () => {}, new AbortController().signal)).rejects.toMatchObject(
			{ retryable: true }
		);
	});

	it('reports monotonic progress during a run', async () => {
		seedChannel();
		const job = claimNextJob(db)!;
		const fractions: number[] = [];
		await pipeline().run(job, (f) => fractions.push(f), new AbortController().signal);
		expect(fractions.length).toBeGreaterThanOrEqual(4);
		const sorted = [...fractions].sort((a, b) => a - b);
		expect(fractions).toEqual(sorted);
		expect(fractions.at(-1)).toBe(1);
	});
});
