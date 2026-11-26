import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type BaseConnector from '@/core/content/connector';

describe('YouTube playback detection', () => {
	let connector: BaseConnector;
	let video: {
		currentTime: number;
		paused: boolean;
		ended: boolean;
		matches: (selector: string) => boolean;
		addEventListener: ReturnType<typeof vi.fn>;
	} | null;
	let documentMock: {
		querySelector: ReturnType<typeof vi.fn>;
		addEventListener: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		vi.resetModules();
		video = {
			currentTime: 0,
			paused: true,
			ended: false,
			matches: (selector) => selector === '.html5-main-video',
			addEventListener: vi.fn(),
		};
		connector = {
			onStateChanged: vi.fn(),
			applyFilter: vi.fn(),
		} as unknown as BaseConnector;
		documentMock = {
			querySelector: vi.fn((selector) =>
				selector === '.html5-main-video' ? video : null,
			),
			addEventListener: vi.fn(),
		};
		vi.stubGlobal('Connector', connector);
		vi.stubGlobal('document', documentMock);
		vi.stubGlobal('Util', {
			getOption: vi.fn().mockResolvedValue(false),
			debugLog: vi.fn(),
			// YouTube can expose this class while background autoplay is paused.
			hasElementClass: vi.fn().mockReturnValue(true),
		});
		vi.stubGlobal('MetadataFilter', {
			createYouTubeFilter: () => ({ append: vi.fn() }),
		});
		await import('@/connectors/youtube');
	});

	afterEach(() => vi.unstubAllGlobals());

	it('waits for a background video to start despite the playing CSS class', () => {
		expect(connector.isPlaying()).toBe(false);
		Object.assign(video!, { paused: false });
		expect(connector.isPlaying()).toBe(false);
		Object.assign(video!, { currentTime: 1 });
		expect(connector.isPlaying()).toBe(true);
	});

	it('does not classify a video waiting to start as a disallowed scrobble', () => {
		expect(connector.scrobblingDisallowedReason()).toBeNull();
	});

	it('detects pauses and the end of playback from the video', () => {
		Object.assign(video!, { currentTime: 20, paused: false });
		expect(connector.isPlaying()).toBe(true);
		Object.assign(video!, { paused: true });
		expect(connector.isPlaying()).toBe(false);
		Object.assign(video!, { paused: false, ended: true });
		expect(connector.isPlaying()).toBe(false);
	});

	it('does not report playback when the video is missing', () => {
		video = null;
		expect(connector.isPlaying()).toBe(false);
	});

	it.each(['timeupdate', 'play', 'pause', 'ended'])(
		'updates playback on %s even when YouTube replaces the video',
		(eventName) => {
			const registration = documentMock.addEventListener.mock.calls.find(
				([name]) => name === eventName,
			);
			expect(registration).toBeDefined();
			const [, listener, capture] = registration!;
			expect(capture).toBe(true);
			const replacement = { ...video!, currentTime: 1, paused: false };
			video = replacement;
			listener({ target: replacement });
			expect(connector.onStateChanged).toHaveBeenCalledOnce();
			listener({ target: { matches: () => false } });
			expect(connector.onStateChanged).toHaveBeenCalledOnce();
		},
	);
});

describe('YouTube Music recognition on YouTube', () => {
	let connector: BaseConnector;
	let videoId: string | null;
	const request = vi.fn<typeof fetch>();
	const recognized = {
		videoDetails: {
			musicVideoType: 'MUSIC_VIDEO_TYPE_OMV',
			author: 'Artist',
			title: 'Song',
		},
	};

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		request.mockReset();
		videoId = 'video-one';
		connector = {
			onStateChanged: vi.fn(),
			applyFilter: vi.fn(),
		} as unknown as BaseConnector;
		vi.stubGlobal('Connector', connector);
		vi.stubGlobal('document', {
			querySelector: () => null,
			addEventListener: vi.fn(),
		});
		vi.stubGlobal('window', { location: { search: '' } });
		vi.stubGlobal('fetch', request);
		vi.stubGlobal('Util', {
			getOption: vi.fn(
				async (_connector: string, key: string) =>
					key === 'scrobbleMusicRecognisedOnly',
			),
			getAttrFromSelectors: vi.fn((selector: string) =>
				selector === 'ytd-watch-flexy' ? videoId : null,
			),
			debugLog: vi.fn(),
		});
		vi.stubGlobal('MetadataFilter', {
			createYouTubeFilter: () => ({ append: vi.fn() }),
		});
		await import('@/connectors/youtube');
		await vi.advanceTimersByTimeAsync(0);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it.each([
		[
			'network failure',
			() => Promise.reject(new TypeError('Network failed')),
		],
		[
			'HTTP 503',
			() => Promise.resolve(new Response('{}', { status: 503 })),
		],
	])(
		'retries a %s and then allows the recognized video',
		async (_, failure) => {
			request
				.mockImplementationOnce(failure)
				.mockImplementationOnce(async () => Response.json(recognized));

			expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
			await vi.advanceTimersByTimeAsync(1_999);
			expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
			expect(request).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1);
			expect(connector.scrobblingDisallowedReason()).toBeNull();
			expect(request).toHaveBeenCalledTimes(2);
			expect(connector.onStateChanged).toHaveBeenCalledOnce();
		},
	);

	it('reports an unavailable lookup after the retry fails', async () => {
		request.mockImplementation(async () => Response.json({ error: {} }));

		expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
		await vi.advanceTimersByTimeAsync(2_000);

		expect(connector.scrobblingDisallowedReason()).toBe(
			'YouTubeMusicLookupFailed',
		);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('cancels a stalled request before retrying', async () => {
		request
			.mockImplementationOnce(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => {
							reject(new Error('Request aborted'));
						});
					}),
			)
			.mockImplementationOnce(async () => Response.json(recognized));

		expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
		await vi.advanceTimersByTimeAsync(8_000);
		expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(request).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(2_000);
		expect(connector.scrobblingDisallowedReason()).toBeNull();
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('keeps a video with no music classification blocked', async () => {
		request.mockResolvedValueOnce(Response.json({ videoDetails: {} }));

		expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
		await vi.advanceTimersByTimeAsync(2_000);

		expect(connector.scrobblingDisallowedReason()).toBe(
			'NotOnYouTubeMusic',
		);
		expect(request).toHaveBeenCalledOnce();
	});

	it('waits for the video ID before looking it up', () => {
		videoId = null;
		expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
		expect(request).not.toHaveBeenCalled();
	});

	it('skips a pending retry after switching videos', async () => {
		request
			.mockRejectedValueOnce(new TypeError('Network failed'))
			.mockImplementationOnce(async () => Response.json(recognized));

		expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
		await vi.advanceTimersByTimeAsync(0);
		videoId = 'video-two';
		expect(connector.scrobblingDisallowedReason()).toBe('IsLoading');
		await vi.advanceTimersByTimeAsync(2_000);

		expect(connector.scrobblingDisallowedReason()).toBeNull();
		expect(request).toHaveBeenCalledTimes(2);
	});
});
