/**
 * This pipeline stage sets a flag to block scrobbling if any of the
 * tags have been blocklisted by the user.
 */

import type Song from '@/core/object/song';
import { debugLog } from '@/core/content/util';
import BlockedTags from '@/core/storage/blocked-tags';

let blockedTags: BlockedTags | undefined;

/**
 * Fill song info by user defined values.
 * @param song - Song instance
 */
export async function process(song: Song): Promise<void> {
	try {
		blockedTags ??= new BlockedTags();
		song.flags.hasBlockedTag = await blockedTags.hasBlockedTag(song);
	} catch (err) {
		debugLog(err, 'error');
	}
}
