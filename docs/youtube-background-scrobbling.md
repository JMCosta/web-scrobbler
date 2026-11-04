# YouTube background playback and local updates

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

The Chromium build includes the published Chrome Web Store public key. Its
extension ID is:

```text
hhinaapppaileiechjoiifaancjggfjm
```

Keeping the same extension ID lets the browser use the original extension's
local and synced storage, including settings, saved edits, accounts, and the
scrobble cache. A build with a different ID receives separate storage and can
look like a fresh installation. This applies to the Chrome Web Store version;
other stores can use different IDs.

1. Keep the original extension installed. Uninstalling it can delete its stored
   data. If an earlier local build created a second copy with a different ID,
   disable that extra copy while checking the update.
2. Run `npm ci`, then `npm run dist chrome` from the source directory.
3. On the browser's Extensions page, use **Load unpacked** and select
   `build/chrome`, the folder containing the generated `manifest.json`.
4. Confirm that the loaded extension reports version **3.23.3** and the ID above.
   Check that the original settings and scrobble cache are visible.
5. Refresh any YouTube tabs that were open during the update so they use the
   updated content script.

**Load unpacked** does not require a private signing key. The manifest's `key`
field is a public identity key, not a private key. See Chrome's documentation on
[consistent extension IDs][ManifestKey] and [loading unpacked extensions][LoadUnpacked].

### Pack extension reports an existing private key

The message **A private key for specified extension already exists** means the
packager is trying to create a signing-key file where one already exists. Keep
the existing `.pem` file and select it in the packager's **Private key file**
field when packing `build/chrome` again.

Packing a CRX requires a private signing key. A newly generated key does not
provide the signing identity of the published extension; the public key in the
manifest does not let a local build sign official store updates.

After installing a packed CRX, the browser keeps its own copy of the extension,
so the unpacked build folder is no longer needed for that installation. Keep the
CRX for installation and keep the `.pem` private and backed up for signing future
updates. An unpacked installation still needs its build folder.

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

For a packed 3.23.2 installation, create the 3.23.3 CRX with the same private
signing key and install it as an update. Its ID must match the installed packed
copy. The original store ID and the locally signed CRX ID can differ, as described
above; do not generate a new key for a routine update.

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

Regression tests cover background playback detection, paused listening time,
temporary blocks clearing before and after the threshold, recovery on resume,
existing restrictions, manual recovery, duplicate playback updates, and the
Chromium extension ID derived from the public key.

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
[LoadUnpacked]: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
[WebAccessibleResources]: https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
