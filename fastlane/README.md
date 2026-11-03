# fastlane — Play Store release for chaosD6 Dimensions

Automates uploading a signed .aab to Google Play's internal/alpha/beta/production tracks and syncing the store listing in `fastlane/metadata/android/en-US/`.

## One-time setup (you do this, I can't)

1. **Google Play Console developer account** — https://play.google.com/console, €25 one-off, verified identity.
2. **Create the app** inside the Console with package name `net.dimensions.radicle` (matches `godot/export_presets.cfg`'s preset 1 and the Firebase project `dimensions-4e9ae`). Fill in the mandatory bits (title, data safety, content rating, privacy policy URL) before you can push to the Internal track.
3. **Signing** — enrol in **Play App Signing**. Upload a release keystore once; Google re-signs each upload with its own key.
4. **Google Play Developer API** — in Google Cloud Console (the same org):
   - Enable **Google Play Android Developer API**.
   - Create a **service account**, download the JSON key.
   - Go back to Play Console → *Users and permissions* → *Invite new users* → paste the service account email → grant **Release manager** on this app.
   - Put the JSON somewhere outside git. Set `PLAY_JSON_KEY=/absolute/path/to/key.json` in your shell (or copy to `fastlane/play-service-account.json`, which is gitignored).
5. **fastlane** — `gem install fastlane -NV` (or `brew install fastlane`).

## Each release

```sh
# 1. Build the .aab from Godot (headless, works on WSL once you have Godot there).
godot --headless --path godot --export-release "Android Play Store (AAB)" ../_tools/chaosd6-release.aab

# 2. Bump versionCode in godot/export_presets.cfg (preset.1, version/code) — Play rejects duplicates.

# 3. Push to Internal testing.
PLAY_JSON_KEY=~/secrets/play-service-account.json fastlane internal

# 4. When happy, promote through the funnel.
fastlane alpha
fastlane beta
fastlane production      # starts at 10% staged rollout; increase in the Console
```

## What's where

- `Appfile` — package name + path to the service-account JSON (via `PLAY_JSON_KEY` env).
- `Fastfile` — the four lanes: `internal`, `alpha`, `beta`, `production`, plus `pull_listing` to re-sync metadata from the Console.
- `metadata/android/en-US/` — store listing, read on every `internal` upload:
  - `title.txt` (≤ 30 chars)
  - `short_description.txt` (≤ 80 chars)
  - `full_description.txt` (≤ 4000 chars)
  - `changelogs/<versionCode>.txt` — the "What's new" copy (≤ 500 chars) per release
  - `images/` — graphics (not scaffolded; see **Assets you still need** below)

## Assets you still need

Google Play requires these before the Internal track accepts an upload. All go in `fastlane/metadata/android/en-US/images/`:

| File | Size | Purpose |
|---|---|---|
| `icon/1.png` | 512×512 PNG, 32-bit | High-res app icon |
| `featureGraphic/1.png` | 1024×500 PNG | Hero image on the Play listing |
| `phoneScreenshots/*.png` | 1080×1920 (or 1920×1080) | 2–8 screenshots, phones |
| `sevenInchScreenshots/*.png` | 1200×1920 | Optional, 7" tablet |
| `tenInchScreenshots/*.png` | 1920×1200 | Optional, 10" tablet |
| `promoGraphic/1.png` | 180×120 | Optional, legacy |

I can generate the base icon from `godot/icon.svg` on request; screenshots have to come from a real device or the Godot runner.

## Privacy policy

You must host a privacy policy at a stable URL (any `https://` link). The game collects no personal data — a 100-line static page saying "no analytics, no accounts, no tracking; the network traffic is Radicle gossip only" is enough. Say the word and I'll draft one at `firebase/public/privacy.html` so it lands on your Firebase domain.

## Data safety declaration

In Play Console → *App content* → *Data safety*, answer:
- Does the app collect / share user data? → **No**.
- Is data encrypted in transit? → **Yes** (Radicle gossip is noise-protocol, HTTPS to the OCI seeder).
- Can users request deletion? → **Not applicable** (nothing stored).

## Content rating

Fill the IARC questionnaire; the game has no gambling, no sexual content, no explicit violence. Expected rating: **PEGI 7 / ESRB E10+** depending on how the fantasy violence is scored.

## CI (optional)

A GitHub Actions workflow at `.github/workflows/android-release.yml` runs `fastlane internal` on every tag `android-v*`. Enable by adding two repo secrets: `PLAY_JSON_KEY_B64` (base64-encoded JSON) and `GODOT_VERSION` (e.g. `4.3-stable`).
