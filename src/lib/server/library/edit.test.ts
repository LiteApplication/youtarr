import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLibrary, readEpisodeInfo, safeLibraryPath } from './browse.ts';
import { applyVideoTags, ingestUpload } from './edit.ts';
import { createSentinel } from './publish.ts';

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), 'youtarr-edit-'));
	createSentinel(root);
	// Settings read from a throwaway config db.
	process.env.CONFIG_DIR = path.join(root, '.config');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.CONFIG_DIR;
});

describe('safeLibraryPath', () => {
	it('rejects escapes', () => {
		expect(() => safeLibraryPath('../outside', root)).toThrow(/escapes/);
		expect(() => safeLibraryPath('a/../../b', root)).toThrow(/escapes/);
		expect(safeLibraryPath('a/b.mp4', root)).toBe(path.join(root, 'a/b.mp4'));
	});
});

describe('upload → edit round trip', () => {
	it('ingests an upload into the templated location and writes an episode NFO', async () => {
		const result = await ingestUpload(
			'my video.mp4',
			Buffer.from('video-bytes'),
			{ title: 'Home Recording', channel: 'Alexis', channelId: 'UC1', season: '2026', episode: 1 },
			{ root }
		);
		expect(result.newPath).toBe('Alexis/Season 2026/Alexis - S2026E001 - Home Recording.mp4');
		expect(existsSync(path.join(root, result.newPath))).toBe(true);
		expect(existsSync(path.join(root, 'Alexis/tvshow.nfo'))).toBe(true);

		const info = readEpisodeInfo(result.newPath, root);
		expect(info).toMatchObject({
			title: 'Home Recording',
			showTitle: 'Alexis',
			season: '2026',
			episode: 1
		});
	});

	it('rejects unsupported upload extensions', async () => {
		await expect(
			ingestUpload(
				'evil.exe',
				Buffer.from('x'),
				{ title: 'T', channel: 'A', season: '2026', episode: 1 },
				{ root }
			)
		).rejects.toThrow(/unsupported video format/);
	});

	it('re-files a video when its metadata changes and prunes the old directory', async () => {
		const first = await ingestUpload(
			'video.mp4',
			Buffer.from('video-bytes'),
			{ title: 'Video', channel: 'Wrong Channel', season: '2020', episode: 1 },
			{ root }
		);
		const result = await applyVideoTags(
			first.newPath,
			{ title: 'Video', channel: 'Right Channel', season: '2020', episode: 1 },
			{ root }
		);
		expect(result.newPath).toBe('Right Channel/Season 2020/Right Channel - S2020E001 - Video.mp4');
		expect(existsSync(path.join(root, result.newPath))).toBe(true);
		// The old season directory is pruned (only its tvshow.nfo survives at the channel level).
		expect(existsSync(path.join(root, 'Wrong Channel/Season 2020'))).toBe(false);

		const info = readEpisodeInfo(result.newPath, root);
		expect(info.showTitle).toBe('Right Channel');
	});

	it('lists the library tree and hides dotted internals', async () => {
		await ingestUpload(
			'video.mp4',
			Buffer.from('video-bytes'),
			{ title: 'T', channel: 'A', season: '2026', episode: 1 },
			{ root }
		);
		mkdirSync(path.join(root, '.youtarr-staging/x'), { recursive: true });
		const top = listLibrary('', root);
		expect(top.map((e) => e.name)).toEqual(['A']);
		const season = listLibrary('A/Season 2026', root);
		expect(season.some((e) => e.name.endsWith('.mp4'))).toBe(true);
	});
});
