import type { ArtistTrackInfo, TrackInfoWithAlbum } from '@/core/types';

export {};

/**
 * Quick links to debug and test the connector:
 *
 * https://www.youtube.com/watch?v=WA3hL4hDx9c - auto-generated music video
 * The connector should get info via `getTopicArtistTrackFromDescription` function
 *
 * https://www.youtube.com/watch?v=eYLbteOm42k - video with chapters available
 * The connector should get info via `getTrackInfoFromChapters` function
 *
 * https://www.youtube.com/watch?v=mHnC_vELJsk - regular video
 * The connector should get info via `getTrackInfoFromTitle` function
 */

/**
 * CSS selector of video element. It's common for both players.
 */
const videoSelector = '.html5-main-video';

const chapterNameSelector = '.html5-video-player .ytp-chapter-title-content';
const videoTitleSelector = [
	'.html5-video-player .ytp-title-link',
	'.slim-video-information-title .yt-core-attributed-string',
];
const channelNameSelector = [
	'#top-row .ytd-channel-name a',
	'.slim-owner-channel-name .yt-core-attributed-string',
];
const videoDescriptionSelector = [
	'#description.ytd-expandable-video-description-body-renderer',
	'#meta-contents #description',
	'.crawler-full-description',
];

const categoryMusic = 'Music';
const categoryEntertainment = 'Entertainment';

/** Categories allowed by the user's settings. */
const allowedCategories: string[] = [];

/**
 * Wether we should only scrobble music recognised by YouTube Music
 */
let scrobbleMusicRecognisedOnly = false;

/**
 * Wether the Youtube Music track info getter is enabled
 */
let getTrackInfoFromYtMusicEnabled = false;

let currentVideoDescription: string | null = null;
let artistTrackFromDescription: TrackInfoWithAlbum | null = null;

type YouTubeMusicLookup =
	| { status: 'unrecognized' }
	| { status: 'recognized'; trackInfo?: ArtistTrackInfo };

interface YouTubeMusicPlayerResponse {
	videoDetails?: {
		musicVideoType?: string;
		author?: string;
		title?: string;
	};
}

type LookupResult<T> =
	| { status: 'loading' | 'unavailable' }
	| { status: 'found'; value: T };

interface LookupEntry<T> {
	result: LookupResult<T>;
	retry?: ReturnType<typeof setTimeout>;
}

const lookupCacheLimit = 128;
const quickRetryDelayMs = 2_000;
const recoveryDelayMs = 30_000;
const maxRecoveryDelayMs = 300_000;
const lookupTimeoutMs = 8_000;
const getYouTubeMusicLookup = createVideoLookup(
	fetchYouTubeMusicLookup,
	'YouTube Music',
);
const getCategoryLookup = createVideoLookup(
	fetchCategoryName,
	'YouTube category',
);

const trackInfoGetters: (() =>
	| ArtistTrackInfo
	| null
	| undefined
	| Record<string, never>
	| TrackInfoWithAlbum)[] = [
	getTrackInfoFromChapters,
	getTrackInfoFromYoutubeMusic,
	getTopicArtistTrackFromDescription,
	getTrackInfoFromTitle,
];

readConnectorOptions();
setupEventListener();

Connector.playerSelector = ['#content', '#player'];

Connector.scrobbleInfoLocationSelector = '#primary #title.ytd-watch-metadata';
Connector.scrobbleInfoStyle = {
	...Connector.scrobbleInfoStyle,
	fontSize: '1.17em',
	fontWeight: '700',
};

Connector.loveButtonSelector =
	'ytd-watch-metadata like-button-view-model button[aria-pressed="false"]';

Connector.unloveButtonSelector =
	'ytd-watch-metadata like-button-view-model button[aria-pressed="true"]';

Connector.getChannelId = () =>
	new URL(
		(
			Util.queryElements([
				'#upload-info .ytd-channel-name .yt-simple-endpoint',
				'.slim-owner-icon-and-title',
			]) as NodeListOf<HTMLAnchorElement>
		)?.[0]?.href ?? 'https://youtube.com/',
	).pathname.slice(1);

Connector.channelLabelSelector = [
	'#primary #title+#top-row ytd-channel-name .yt-formatted-string',
	'.slim-owner-icon-and-title .yt-core-attributed-string',
];

Connector.getTrackInfo = () => {
	const trackInfo: TrackInfoWithAlbum = {};

	for (const getter of trackInfoGetters) {
		const currentTrackInfo = getter();
		if (!currentTrackInfo) {
			continue;
		}

		if (!trackInfo.artist) {
			trackInfo.artist = currentTrackInfo.artist;
		}

		if (!trackInfo.track) {
			trackInfo.track = currentTrackInfo.track;
		}

		if (!trackInfo.album && 'album' in currentTrackInfo) {
			trackInfo.album = currentTrackInfo.album;
		}

		if (!Util.isArtistTrackEmpty(trackInfo)) {
			break;
		}
	}

	return trackInfo;
};

Connector.getTimeInfo = () => {
	const videoElement = document.querySelector(
		videoSelector,
	) as HTMLVideoElement;
	if (videoElement && !areChaptersAvailable()) {
		let { currentTime, duration, playbackRate } = videoElement;

		currentTime /= playbackRate;
		duration /= playbackRate;

		return { currentTime, duration };
	}

	return null;
};

Connector.isPlaying = () => {
	const video = document.querySelector<HTMLVideoElement>(videoSelector);
	// The player can have playing-mode while background autoplay is paused.
	return Boolean(
		video &&
			video.currentTime > 0 &&
			!video.paused &&
			!video.ended &&
			!video.seeking &&
			video.readyState >= 3, // HAVE_FUTURE_DATA
	);
};

Connector.getOriginUrl = () => {
	const videoId = getVideoId();

	return `https://youtu.be/${videoId}`;
};

Connector.useUniqueIdAsTrackIdentity = true;
Connector.getUniqueID = () => {
	if (areChaptersAvailable()) {
		return null;
	}

	return getVideoId();
};

Connector.scrobblingDisallowedReason = () => {
	if (document.querySelector('.ad-showing')) {
		return 'IsAd';
	}
	if (!scrobbleMusicRecognisedOnly && allowedCategories.length === 0) {
		return null;
	}

	const videoId = getVideoId();
	if (scrobbleMusicRecognisedOnly) {
		const result = getYouTubeMusicLookup(videoId);
		if (result.status === 'loading') {
			return 'IsLoading';
		}
		if (result.status === 'unavailable') {
			return 'YouTubeMusicLookupFailed';
		}
		if (
			result.status === 'found' &&
			result.value.status === 'unrecognized'
		) {
			return 'NotOnYouTubeMusic';
		}
	}

	if (allowedCategories.length > 0) {
		const result = getCategoryLookup(videoId);
		if (result.status === 'loading') {
			return 'IsLoading';
		}
		if (result.status === 'unavailable') {
			return 'YouTubeCategoryLookupFailed';
		}
		if (
			result.status === 'found' &&
			!allowedCategories.includes(result.value)
		) {
			return 'ForbiddenYouTubeCategory';
		}
	}
	return null;
};

Connector.applyFilter(
	MetadataFilter.createYouTubeFilter().append({
		artist: [removeLtrRtlChars, removeNumericPrefix],
		track: [removeLtrRtlChars, removeNumericPrefix],
	}),
);

function setupEventListener() {
	// Capture media events so this also works for videos created or replaced later.
	for (const eventName of [
		'timeupdate',
		'play',
		'playing',
		'pause',
		'waiting',
		'seeking',
		'seeked',
		'ended',
	]) {
		document.addEventListener(
			eventName,
			(event) => {
				if ((event.target as Element | null)?.matches(videoSelector)) {
					Connector.onStateChanged();
				}
			},
			true,
		);
	}
}

function areChaptersAvailable() {
	const text = Util.getTextFromSelectors(chapterNameSelector);

	// SponsorBlock extension hijacks chapter element. Ignore it.
	if (
		document.querySelector(
			'.ytp-chapter-title-content.sponsorBlock-segment-title',
		)
	) {
		return false;
	}

	// Chapters from the description have an "engagement panel" (sidebar),
	// separate from "auto-chapters" which also have a one, but it's different.
	// Some Music Videos also get text "In this video" inserted where the chapter
	// would be, which this also catches because that only gets inserted when
	// there are no description chapters.
	if (
		!document.querySelector(
			'[target-id="engagement-panel-macro-markers-description-chapters"]',
		)
	) {
		return false;
	}

	// Return the text if no sponsorblock text.
	return text;
}

function getVideoId() {
	/*
	 * ytd-watch-flexy element contains ID of a first played video
	 * if the miniplayer is visible, so we should check
	 * if URL of a current video in miniplayer is accessible.
	 */
	const miniPlayerVideoUrl = Util.getAttrFromSelectors(
		'ytd-miniplayer[active] [selected] a',
		'href',
	);
	if (miniPlayerVideoUrl) {
		return Util.getYtVideoIdFromUrl(miniPlayerVideoUrl);
	}

	const videoIDDesktop = Util.getAttrFromSelectors(
		'ytd-watch-flexy',
		'video-id',
	);
	if (videoIDDesktop) {
		return videoIDDesktop;
	}

	// as a fallback on mobile, try to get the video ID from the URL
	const videoIDMobile = new URLSearchParams(window.location.search).get('v');
	return videoIDMobile;
}

async function fetchCategoryName(videoId: string, signal: AbortSignal) {
	// The current URL and DOM may point to a different video in the miniplayer.
	const videoUrl = `${location.origin}/watch?v=${videoId}`;
	const response = await fetch(videoUrl, { signal });
	if (!response.ok) {
		throw new Error(`YouTube returned HTTP ${response.status}`);
	}

	const rawHtml = await response.text();
	const category = rawHtml.match(/"category":"(.+?)"/)?.[1];
	if (!category) {
		throw new Error('YouTube returned no video category');
	}
	return category;
}

/**
 * Asynchronously read connector options.
 */
async function readConnectorOptions() {
	if (await Util.getOption('YouTube', 'scrobbleMusicOnly')) {
		allowedCategories.push(categoryMusic);
	}
	if (await Util.getOption('YouTube', 'scrobbleEntertainmentOnly')) {
		allowedCategories.push(categoryEntertainment);
	}
	Util.debugLog(`Allowed categories: ${allowedCategories.join(', ')}`);

	if (await Util.getOption('YouTube', 'scrobbleMusicRecognisedOnly')) {
		scrobbleMusicRecognisedOnly = true;
		Util.debugLog('Only scrobbling when recognised by YouTube Music');
	}

	if (await Util.getOption('YouTube', 'enableGetTrackInfoFromYtMusic')) {
		getTrackInfoFromYtMusicEnabled = true;
		Util.debugLog('Get track info from YouTube Music enabled');
	}
}

function getVideoDescription() {
	return Util.getTextFromSelectors(videoDescriptionSelector)?.trim() ?? null;
}

function getTopicArtistTrackFromDescription() {
	const description = getVideoDescription();
	if (currentVideoDescription === description) {
		return artistTrackFromDescription;
	}

	currentVideoDescription = description;
	artistTrackFromDescription = Util.parseYtTopicVideoDescription(description);

	return artistTrackFromDescription;
}

function getTrackInfoFromYoutubeMusic(): ArtistTrackInfo | undefined {
	if (!getTrackInfoFromYtMusicEnabled) {
		return;
	}

	const result = getYouTubeMusicLookup(getVideoId());
	if (result.status === 'found' && result.value.status === 'recognized') {
		return result.value.trackInfo;
	}
}

function createVideoLookup<T>(
	fetchValue: (videoId: string, signal: AbortSignal) => Promise<T>,
	label: string,
) {
	const cache = new Map<string, LookupEntry<T>>();
	const loading = { status: 'loading' } as const;

	async function load(
		videoId: string,
		entry: LookupEntry<T>,
		delayMs: number,
	) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), lookupTimeoutMs);
		try {
			const value = await fetchValue(videoId, controller.signal);
			entry.result = { status: 'found', value };
		} catch (error) {
			if (cache.get(videoId) !== entry) {
				return;
			}
			Util.debugLog(
				`${label} lookup failed for ${videoId}: ${error}`,
				'warn',
			);
			const nextDelayMs = Math.min(
				Math.max(delayMs * 2, recoveryDelayMs),
				maxRecoveryDelayMs,
			);
			entry.retry = setTimeout(() => {
				entry.retry = undefined;
				if (getVideoId() === videoId) {
					void load(videoId, entry, nextDelayMs);
				} else {
					cache.delete(videoId);
				}
			}, delayMs);
			if (
				delayMs === quickRetryDelayMs ||
				entry.result.status === 'unavailable'
			) {
				return;
			}
			entry.result = { status: 'unavailable' };
		} finally {
			clearTimeout(timeout);
		}

		if (cache.get(videoId) === entry && getVideoId() === videoId) {
			Connector.onStateChanged();
		}
	}

	return (videoId: string | null): LookupResult<T> => {
		if (!videoId) {
			return loading;
		}
		const cached = cache.get(videoId);
		if (cached) {
			return cached.result;
		}

		if (cache.size >= lookupCacheLimit) {
			const oldest = cache.entries().next();
			if (!oldest.done) {
				const [oldId, oldEntry] = oldest.value;
				clearTimeout(oldEntry.retry);
				cache.delete(oldId);
			}
		}
		const entry: LookupEntry<T> = { result: loading };
		cache.set(videoId, entry);
		void load(videoId, entry, quickRetryDelayMs);
		return loading;
	};
}

async function fetchYouTubeMusicLookup(
	videoId: string,
	signal: AbortSignal,
): Promise<YouTubeMusicLookup> {
	const body = JSON.stringify({
		context: {
			client: {
				// parameters are needed, you get a 400 if you omit these
				// specific values are just what I got when doing a request
				// using firefox
				clientName: 'WEB_REMIX',
				clientVersion: '1.20221212.01.00',
			},
		},
		captionParams: {},
		videoId,
	});

	const response = await fetch(
		'https://music.youtube.com/youtubei/v1/player',
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body,
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`YouTube Music returned HTTP ${response.status}`);
	}

	const { videoDetails } =
		(await response.json()) as YouTubeMusicPlayerResponse;
	if (!videoDetails) {
		throw new Error('YouTube Music returned no video details');
	}
	if (!videoDetails.musicVideoType?.startsWith('MUSIC_VIDEO_')) {
		return { status: 'unrecognized' };
	}
	// Other video types can be recognized as music without usable track metadata.
	if (videoDetails.musicVideoType !== 'MUSIC_VIDEO_TYPE_OMV') {
		return { status: 'recognized' };
	}
	return {
		status: 'recognized',
		trackInfo: {
			artist: videoDetails.author,
			track: videoDetails.title,
		},
	};
}

function getTrackInfoFromChapters() {
	// Short circuit if chapters not available - necessary to avoid misscrobbling with SponsorBlock.
	if (!areChaptersAvailable()) {
		return {
			artist: null,
			track: null,
		};
	}

	const chapterName = Util.getTextFromSelectors(chapterNameSelector);
	const artistTrack = Util.processYtVideoTitle(chapterName);
	if (!artistTrack.track) {
		artistTrack.track = chapterName;
	}
	return artistTrack;
}

function getTrackInfoFromTitle(): ArtistTrackInfo {
	let { artist, track } = Util.processYtVideoTitle(
		Util.getTextFromSelectors(videoTitleSelector),
	);
	if (!artist) {
		const channelName = Util.getTextFromSelectors(channelNameSelector);
		const re =
			// eslint-disable-next-line no-irregular-whitespace
			/^(?:Mavzu|Тема|الموضوع|ਵਿਸ਼ਾ)\s[–-]\s|(?:(?:\s[-—–]|[:՝])\s(?:Onderwerp|Mövzu|Topik|tema|Tema|téma|Emne|Thema|teema|Topic|gaia|Paksa|Sujet|Isihloko|Efni|Mada|tēma|téma|emne|temat|Tópico|Subiect|aihekanava|Ämne|Chủ đề|Konu|тэма|Тема|Тақырып|Сэдэв|тема|Θέμα|թեմա|נושא|موضوع|عنوان|विषय|বিষয়বস্তু|বিষয়|મુદ્દો|ବିଷୟ|தலைப்பு|అంశం|ವಿಷಯ|വിഷയം|මාතෘකාව|หัวข้อ|ຫົວ​ຂໍ້|ခေါင်းစဉ်|თემა|ርዕስ|ប្រធាន​បទ|主题|主題|トピック|주제)|\s\(tema\))$/;
		artist = channelName?.replace(re, '') ?? null;
	}

	return { artist, track };
}

function removeLtrRtlChars(text: string) {
	return MetadataFilter.filterWithFilterRules(text, [
		{ source: /\u200e/g, target: '' },
		{ source: /\u200f/g, target: '' },
	]);
}

function removeNumericPrefix(text: string) {
	return MetadataFilter.filterWithFilterRules(text, [
		// `NN.` or `NN)`
		{ source: /^\d{1,2}[.)]\s?/, target: '' },
		/*
		 * `(NN).` Ref: https://www.youtube.com/watch?v=KyabZRQeQgk
		 * NOTE Initial tracklist format is (NN)  dd:dd  Artist - Track
		 * YouTube adds a dot symbol after the numeric prefix.
		 */
		{ source: /^\(\d{1,2}\)\./, target: '' },
	]);
}
