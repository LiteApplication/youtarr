import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteLibraryEntry } from './delete.ts';
import { ingestUpload, type EditableVideoTags } from './edit.ts';
import { createSentinel } from './publish.ts';

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), 'youtarr-delete-'));
	createSentinel(root);
	process.env.CONFIG_DIR = path.join(root, '.config');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.CONFIG_DIR;
});

async function seed(tags: EditableVideoTags): Promise<string> {
	const { newPath } = await ingestUpload('video.mp4', Buffer.from('video-bytes'), tags, { root });
	return newPath;
}

describe('deleteLibraryEntry', () => {
	it('deletes a lone episode and prunes the now-empty season directory', async () => {
		const rel = await seed({ title: 'Only Video', channel: 'Solo', season: '2024', episode: 1 });
		const result = deleteLibraryEntry(rel, { root });
		expect(result.kind).toBe('episode');
		expect(existsSync(path.join(root, rel))).toBe(false);
		expect(existsSync(path.join(root, 'Solo/Season 2024'))).toBe(false);
		// The channel directory itself survives - tvshow.nfo lives there.
		expect(existsSync(path.join(root, 'Solo/tvshow.nfo'))).toBe(true);
	});

	it('deletes one episode but keeps siblings in the same season', async () => {
		await seed({ title: 'First', channel: 'Band', season: '2024', episode: 1 });
		const second = await seed({ title: 'Second', channel: 'Band', season: '2024', episode: 2 });

		deleteLibraryEntry(second, { root });

		const seasonDir = path.join(root, 'Band/Season 2024');
		expect(existsSync(seasonDir)).toBe(true);
		expect(existsSync(path.join(seasonDir, 'Band - S2024E001 - First.mp4'))).toBe(true);
		expect(existsSync(path.join(seasonDir, 'Band - S2024E002 - Second.mp4'))).toBe(false);
		expect(existsSync(path.join(seasonDir, 'Band - S2024E002 - Second.nfo'))).toBe(false);
	});

	it('deletes a season directory but leaves other seasons of the channel', async () => {
		await seed({ title: 'A', channel: 'Prolific', season: '2023', episode: 1 });
		await seed({ title: 'B', channel: 'Prolific', season: '2024', episode: 1 });

		const result = deleteLibraryEntry('Prolific/Season 2023', { root });
		expect(result.kind).toBe('season');
		expect(existsSync(path.join(root, 'Prolific/Season 2023'))).toBe(false);
		expect(existsSync(path.join(root, 'Prolific/Season 2024'))).toBe(true);
	});

	it('deletes a channel directory and everything under it', async () => {
		await seed({ title: 'A', channel: 'Gone', season: '2023', episode: 1 });
		await seed({ title: 'B', channel: 'Gone', season: '2024', episode: 1 });

		const result = deleteLibraryEntry('Gone', { root });
		expect(result.kind).toBe('channel');
		expect(existsSync(path.join(root, 'Gone'))).toBe(false);
	});

	it('refuses to escape the library, delete the root, or delete a missing entry', () => {
		expect(() => deleteLibraryEntry('../outside', { root })).toThrow(/escapes/);
		expect(() => deleteLibraryEntry('', { root })).toThrow(/library root/);
		expect(() => deleteLibraryEntry('nope/gone.mp4', { root })).toThrow(/not found/);
	});
});
