# YouTube playback, recovery, and local updates

## Playback and recovery in 3.24.0.2

-   Background playback starts counting when the video actually advances.
    Pausing, buffering, and seeking suspend the listening timer.
-   A metadata correction for the same video preserves its listening time and
    submitted status. Reprocessing metadata or saving a regex edit also
    preserves the status of a play already submitted. A replay after the video
    finishes can scrobble again once it reaches the listening threshold.
-   A late metadata result from an earlier play cannot update the current
    video's metadata or timers.
-   Failed YouTube Music and category lookups retry automatically. After a
    quick retry, the delay starts at 30 seconds and increases to five minutes
    between attempts. The video stays blocked while a required lookup is
    unavailable.
-   If recognition returns and the same play already reached the listening
    threshold, it can recover automatically. If the extension loses the
    background worker's reply to a submission, it keeps the play in the
    scrobble cache for manual recovery. A lost reply can also follow a
    successful submission, so check your listening history before resubmitting.

### Resource use

The blocked-tag check reuses one storage wrapper across tracks. The YouTube
Music and category lookup caches each hold up to 128 video results per tab. A
revisit after eviction starts a fresh lookup.

In an isolated Chromium comparison with mocked network and storage, the
upstream build and this fork both made two requests per new video with both
filters enabled and performed 16 playback state refreshes in eight seconds.
For 200 blocked-tag checks, the fork reduced recurring timers and storage
writes from 200 each to one each.

## Background-tab scrobbling fix in 3.23.2

A YouTube video opened paused in a background tab could appear as **Scrobbling
now** on Last.fm after the tab was activated, but never become a saved scrobble.
The extension could also place that play in **Disallowed Scrobbles**.

YouTube's player can expose its `playing-mode` CSS class before the video
actually plays. The connector previously treated that class as playback, while
separately blocking a video whose playback position was still zero. The listening
timer could therefore expire during the block. Clearing the block sent another
Now Playing update without retrying the missed scrobble.

The fix changes the following behavior:

-   Playback starts counting once the video has advanced beyond zero and is
    neither paused nor ended. Paused time does not count toward the threshold.
-   Captured `timeupdate`, `play`, `pause`, and `ended` events update playback
    detection even when YouTube creates or replaces its video element.
-   If the listening threshold has already been reached, an eligible play can
    recover its missed scrobble when a block clears. Repeated playback updates
    do not submit that recovery more than once while it is in progress.
-   A successful recovery removes the old disallowed cache entry and keeps the
    scrobbled indicator when playback pauses or resumes.

Category, channel, tag, advertisement, and recognition restrictions still apply.
Clearing a block before the listening threshold does not cause an early scrobble.

## Updating a local build in Chrome or Opera

### Unpacked build using the Chrome Web Store ID

The Chromium build includes the published Chrome Web Store public key. Its
extension ID is:

```text
hhinaapppaileiechjoiifaancjggfjm
```

The browser associates local and synced storage, including settings, saved
edits, accounts, and the scrobble cache, with the extension ID. The ID above
applies to the Chrome Web Store build. Other stores and locally packed builds
can use different IDs.

1. Keep the original extension installed. Uninstalling it can delete its stored
   data. If an earlier local build created a second copy with a different ID,
   disable that extra copy while checking the update.
2. Run `npm ci`, then `npm run dist chrome` from the source directory.
3. On the browser's Extensions page, use **Load unpacked** and select
   `build/chrome`, the folder containing the generated `manifest.json`.
4. Confirm that the loaded extension reports the version in the generated
   manifest and the ID above. Check that the settings and scrobble cache are
   visible.
5. Refresh any YouTube tabs that were open during the update so they use the
   updated content script.

**Load unpacked** uses the public identity key in the manifest. See Chrome's documentation on
[consistent extension IDs][ManifestKey] and [loading unpacked extensions][LoadUnpacked].

### Updating an existing packed Opera installation

1. In `opera://extensions`, note the ID and version of the installed packed copy.
2. Keep the existing copy installed and open the signed `.crx` as an update.
   The 3.24.0.2 package updates the 3.24.0.1 package when both were signed with
   the same key.
3. Confirm the ID matches the existing copy and the version reads **3.24.0.2**.
   Refresh any open YouTube tabs so they use the updated connector.

For a subsequent local package, build the Chromium extension and prepare a
copy of `build/chrome`. Set the copy's manifest version to a value
[higher than the installed version][ManifestVersion] and remove the Chrome
Web Store `key` field from that copy before packing. In Opera's
**Pack Extension** dialog, select the built folder and the existing `.pem`
under **Private key file**. Use that same key for each local update to keep the
extension ID and its data.

If Opera reports **A private key for specified extension already exists**,
select the existing key in the dialog. Store the `.pem` privately and share
only the signed `.crx`.

## Console messages in 3.23.3

Repeated **Cannot find menu item with id** errors mean that a menu update reached
the browser before that menu existed. Version 3.23.3 waits for menu creation to
finish before sending updates. Startup and simultaneous tab events share one
initialization, and a restarted service worker recreates persisted menu IDs
without duplicate creation. Menu failures are handled and reported without
preventing the extension icon and title from updating.

**ListenBrainz: no data** followed by **No data in storage** can occur when the
Accounts page checks a ListenBrainz account that has never been connected.
An absent account record is now treated as signed out without error logging or
unnecessary sign-out writes. This does not sign the account in or restore data
from another extension ID. Actual storage failures still propagate.

### Origin-check messages on YouTube

Opera can report **Unsafe attempt to load URL** followed by **Domains, protocols
and ports must match** for `connectors/youtube.js` or `icons/icon_main_48.png`.
These messages alone do not establish that the connector failed or that a
scrobble was lost.

In an isolated Opera check of version 3.23.3 on a YouTube watch page, both
resources returned HTTP 200. The YouTube connector executed in the extension's
isolated context, and the icon loaded at 48 by 48 pixels. Separate page requests
also succeeded, while Opera still logged the origin-check messages. The installed
manifest already declared both paths as web-accessible resources; see
[Chrome's resource documentation][WebAccessibleResources].

The cause of the extra messages remains unconfirmed. Version 3.23.3 fixes the
menu and ListenBrainz messages described above; it does not include a fix for
these origin-check messages. This resource-loading check did not submit a live
Last.fm scrobble.

If these messages accompany missing scrobbles, check for an actual failed request
in the page's Network panel and confirm whether the extension reaches its
scrobbled indicator. Verify that Last.fm retains the play in listening history
after **Scrobbling now** ends. A failed connector request or missing saved play
needs further investigation, even if similar console messages previously
appeared alongside successful resource loading.

## Verification

Run the automated checks with:

```sh
npm run test -- --run
npm run checkts
npm run lint
npm run dist chrome
```

Regression tests cover starting YouTube playback in a background tab,
switching tabs just after playback starts, buffering and seeking, recovery
from failed lookups, rapid switches, and replays. They also verify listening
time across metadata corrections, caching when a submission reply is lost,
and reuse of the blocked-tag storage timer.

Additional tests cover asynchronous menu creation, simultaneous startup and tab
updates, worker restarts, menu API failures, and unconfigured ListenBrainz
accounts. A fresh, isolated Opera profile was also used to load the 3.23.3
Accounts page and update all five menu IDs; none of the reported console errors
occurred in that check.

For a browser check, open a YouTube music video paused in a background tab and
leave it there longer than the normal scrobbling threshold. Activate the tab
and start playback. The extension should wait for the required listening time,
then show its scrobbled indicator; Last.fm should retain the play in listening
history after the Now Playing status ends. Also pause and resume a play to
confirm that paused time is excluded.

The user reported that the original scrobbling issue was resolved in Opera with
the 3.23.2 build. Automated tests use simulated browser and service responses;
they do not submit test plays to a live Last.fm account.

[ManifestKey]: https://developer.chrome.com/docs/extensions/reference/manifest/key
[ManifestVersion]: https://developer.chrome.com/docs/extensions/reference/manifest/version
[LoadUnpacked]: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
[WebAccessibleResources]: https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
