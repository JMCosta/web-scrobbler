import { expect, it, vi } from 'vitest';
import Song from '@/core/object/song';

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock('webextension-polyfill', () => ({
	default: { storage: { local: storage, sync: storage } },
}));

it('reuses one blocked-tag storage timer and reads updated rules for the next track', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	try {
		storage.get.mockResolvedValue({});
		storage.set.mockResolvedValue(undefined);
		const { process } = await import('@/core/object/pipeline/blocked-tags');
		const connector = {
			id: 'YouTube',
			label: 'YouTube',
			matches: [],
			js: 'youtube.js',
		};
		const firstSong = new Song(
			{ artist: 'Artist', track: 'First' },
			connector,
		);
		await process(firstSong);
		expect(firstSong.flags.hasBlockedTag).toBe(false);
		expect(storage.set).toHaveBeenCalledOnce();
		const timers = vi.getTimerCount();

		storage.get.mockResolvedValue({
			BlockedTags: {
				Artist: { tracks: { Second: true }, albums: {} },
			},
		});
		const secondSong = new Song(
			{ artist: 'Artist', track: 'Second' },
			connector,
		);
		await process(secondSong);

		expect(secondSong.flags.hasBlockedTag).toBe(true);
		expect(storage.set).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(timers);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});
