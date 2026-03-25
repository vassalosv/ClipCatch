# ClipCatch v0.7.2 — Open Completed Downloads

ClipCatch `v0.7.2` improves the post-download workflow in the popup. Once a file or built-in HLS/DASH stream finishes, you can now open the downloaded file with the system default app or reveal it in its folder directly from the Downloads panel.

## What's New

- Added **Open downloaded file** and **Open downloaded folder** actions for completed direct downloads
- Added the same post-download actions for completed built-in HLS/DASH stream downloads

## Improvements

- HLS save jobs are now linked to their Chrome download entries after the offscreen assembler hands the file off to the browser
- Completed stream rows keep the final saved filename so the Downloads panel reflects the actual output file

## Fixes

- Stream jobs no longer transition to a fully completed state before Chrome has registered the saved file
- Version references were updated to `0.7.2` in the manifest, popup UI, and changelog
