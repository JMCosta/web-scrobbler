/**
 * The module applies functions provided by pipeline stages to given song.
 */
import * as UserInput from '@/core/object/pipeline/user-input';
import * as Copy from '@/core/object/pipeline/copy';
import * as Metadata from '@/core/object/pipeline/metadata';
import * as Normalize from '@/core/object/pipeline/normalize';
import * as RegexEdits from '@/core/object/pipeline/regex-edits';
import * as CoverArtArchive from '@/core/object/pipeline/coverartarchive/coverartarchive';
import * as BlockedTags from '@/core/object/pipeline/blocked-tags';
import Song from '@/core/object/song';
import type { ConnectorMeta } from '@/core/connectors';

export default class Pipeline {
	private processors = [
		Copy,
		Normalize,
		UserInput,
		RegexEdits,
		Metadata,
		RegexEdits, // Run regex edits again, as the regex edit might have caused an album to be found.
		BlockedTags,
		CoverArtArchive,
	];
	async process(
		song: Song,
		connector: ConnectorMeta,
		isCurrent = () => true,
	): Promise<boolean> {
		// An in-flight processor may still write to its input after being superseded.
		// Keep those writes isolated, including when the same play is reprocessed.
		const draft = new Song(song.parsed, song.connector);
		draft.metadata.startTimestamp = song.metadata.startTimestamp;
		song.flags.finishedProcessing = false;

		try {
			for (const processor of this.processors) {
				await processor.process(draft, connector);
				if (!isCurrent()) {
					return false;
				}
			}

			song.processed = draft.processed;
			song.noRegex = draft.noRegex;
			draft.metadata.userloved = song.metadata.userloved;
			draft.metadata.notificationId = song.metadata.notificationId;
			song.metadata = draft.metadata;
			Object.assign(song.flags, {
				isValid: draft.flags.isValid,
				isCorrectedByUser: draft.flags.isCorrectedByUser,
				isRegexEditedByUser: draft.flags.isRegexEditedByUser,
				isAlbumFetched: draft.flags.isAlbumFetched,
				hasBlockedTag: draft.flags.hasBlockedTag,
			});
			return true;
		} finally {
			if (isCurrent()) {
				song.flags.finishedProcessing = true;
			}
		}
	}
}
