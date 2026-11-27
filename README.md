<div align="center">

<p>
	<img width="128" src="./src/icons/main/universal.svg"/>
</p>
<h1>Web Scrobbler</h1>

[![Chrome Web Store][WebStoreBadge]][WebStore]
[![Addons.mozilla.org][AmoBadge]][Amo]
[![iTunes App Store][AppleStoreBadge]][AppleStore]
[![Microsoft Edge Addons][EdgeBadge]][Edge]

[![Discord][DiscordBadge]][Discord]
[![Upstream test status][GitHubActionsBadge]][GitHubActions]
[![Codacy Badge][CodacyBadge]][Codacy]
[![Codacy Coverage Badge][CodacyCoverageBadge]][Codacy]
[![Crowdin Badge][CrowdinBadge]][Crowdin]

</div>

Web Scrobbler helps online music listeners to scrobble their playback history.

## This fork

This fork improves YouTube scrobbling in background tabs and during rapid track
changes. It retries failed YouTube Music and category lookups and keeps listening
time tied to the original play when a video's metadata changes.

The packed Opera update is **3.24.0.2**. See the [playback, recovery, and update
notes](docs/youtube-background-scrobbling.md) for the changes and installation
steps. The extension-store links below point to the upstream project.

## Supported Services

-   [Last.fm][LastFm]
-   [Libre.fm][LibreFm]
-   [ListenBrainz][ListenBrainz]
-   [Maloja][Maloja]
-   [Pleroma][Pleroma]

## Installation

The extension can be either downloaded from stores, or installed as an [unpacked extension][DocsUnpacked].

### Chrome Web Store

It can be installed directly from the [Chrome Web Store][WebStore] for Chrome users.

If you already use a packed Opera build of this fork, follow the
[packed Opera update steps](docs/youtube-background-scrobbling.md#updating-an-existing-packed-opera-installation).

### Addons.mozilla.org

For those who prefer Firefox, the extension is available on [Addons.mozilla.org][Amo].

### Safari

The extension is also available in the [Apple Store][AppleStore].


### Microsoft Edge Add-ons

The extension is also available on the [Microsoft Edge Add-ons][Edge].

### Install from source code

To install the extension from sources or zip file, read
[this page][WikiUnpacked] if you're on Chrome, or [this one][WikiTempAddon]
if you use Firefox.

Use **Load unpacked** with the built `build/chrome` folder. The Chromium build
uses the Chrome Web Store extension ID. For a local update, follow the
[instructions for your installed build](docs/youtube-background-scrobbling.md#updating-a-local-build-in-chrome-or-opera).

## Development

### Build the extension

Before building the extension you should install dependencies:

```sh
# Install dependencies
> npm ci

# Build the extension
> npm run dist firefox
# or
> npm run dist chrome
# or (requires Xcode (xcrun and xcodebuild))
> npm run dist safari
```

The built extension is available in the browser's subdirectory of `build`, such
as `build/chrome` or `build/firefox`. You can load that directory as an unpacked
extension. Chromium distribution builds also produce `web-scrobbler-chrome.zip`.

The detailed build instruction is available [here][BuildInstructions].

### Run regression tests

Run `npm run test -- --run` and `npm run checkts`. The
[verification notes](docs/youtube-background-scrobbling.md#verification)
describe the YouTube playback and recovery cases covered by the tests.

### Develop connectors

Check the [wiki page][WikiDev] to understand development of connectors. Please
also read our [contribution guidelines][Contributing].

### Translations

Follow the [Translation wiki][Translations] for details.

## Media

Follow [@web_scrobbler][Twitter] on Twitter to receive the latest news and updates.

Join the [Discord channel][Discord] to discuss the extension.

## Privacy Policy

See the [privacy policy][Privacy].

## License

Licensed under the [MIT License][License].

<!-- Badges -->

[CrowdinBadge]: https://badges.crowdin.net/web-scrobbler-test/localized.svg
[AmoBadge]: https://img.shields.io/amo/v/web-scrobbler.svg?label=firefox&logo=firefox-browser&logoColor=white
[CodacyBadge]: https://app.codacy.com/project/badge/Grade/ab1b7aac4f4f4f0d84a2ff3906be05cf
[CodacyCoverageBadge]: https://app.codacy.com/project/badge/Coverage/ab1b7aac4f4f4f0d84a2ff3906be05cf
[DiscordBadge]: https://img.shields.io/discord/716363971070001202?logo=discord&logoColor=white&color=7289dA
[EdgeBadge]: https://img.shields.io/badge/dynamic/json?label=edge&logo=microsoft-edge&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fobiekdelmkmlgnhddmmnpnfhngejbnnc
[GitHubActionsBadge]: https://img.shields.io/github/actions/workflow/status/web-scrobbler/web-scrobbler/test.yml
[WebStoreBadge]: https://img.shields.io/chrome-web-store/v/hhinaapppaileiechjoiifaancjggfjm.svg?label=chrome&logo=google-chrome&logoColor=white
[AppleStoreBadge]: https://img.shields.io/itunes/v/6449224218?label=safari&logo=apple&logoColor=white

<!-- Docs -->

[BuildInstructions]: https://github.com/web-scrobbler/web-scrobbler/wiki/Setup-development-environment
[Contributing]: https://github.com/web-scrobbler/web-scrobbler/blob/master/.github/CONTRIBUTING.md
[DocsUnpacked]: https://developer.chrome.com/extensions/getstarted#unpacked
[License]: https://github.com/web-scrobbler/web-scrobbler/blob/master/LICENSE.md
[Privacy]: https://github.com/web-scrobbler/web-scrobbler/blob/master/src/_locales/en/privacy.md
[Translations]: https://github.com/web-scrobbler/web-scrobbler/wiki/Translate-the-extension

<!-- Download -->

[Amo]: https://addons.mozilla.org/en-US/firefox/addon/web-scrobbler/
[Edge]: https://microsoftedge.microsoft.com/addons/detail/web-scrobbler/obiekdelmkmlgnhddmmnpnfhngejbnnc
[WebStore]: https://chrome.google.com/webstore/detail/lastfm-scrobbler/hhinaapppaileiechjoiifaancjggfjm
[AppleStore]: https://apps.apple.com/app/web-scrobbler/id6449224218

<!-- Related pages -->

[Codacy]: https://app.codacy.com/gh/web-scrobbler/web-scrobbler/dashboard
[Discord]: https://discord.com/invite/u99wNWw
[GitHubActions]: https://github.com/web-scrobbler/web-scrobbler/actions
[Twitter]: https://twitter.com/web_scrobbler
[Crowdin]: https://crowdin.com/project/web-scrobbler-test

<!-- Services -->

[LastFm]: http://www.last.fm/
[LibreFm]: https://libre.fm/
[ListenBrainz]: https://listenbrainz.org/
[Maloja]: https://github.com/krateng/maloja
[Pleroma]: https://pleroma.social/

<!-- Wiki pages -->

[WikiDev]: https://github.com/web-scrobbler/web-scrobbler/wiki/Connectors-development
[WikiTempAddon]: https://github.com/web-scrobbler/web-scrobbler/wiki/Install-a-temporary-add-on
[WikiUnpacked]: https://github.com/web-scrobbler/web-scrobbler/wiki/Install-an-unpacked-extension
