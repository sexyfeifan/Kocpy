# Media runtime notice

Kocpy invokes FFmpeg as a separate command-line process. Kocpy's own source
license remains MIT. This directory contains FFmpeg 9.0.1 built with x264
commit b35605ace3ddf7c1a5d67a2eb553f034aef41d55, licensed under
**GPL version 2 or later**, not MIT. There is no nonfree build configuration.

Copyright belongs to the FFmpeg and x264 authors; see the complete notices in
the supplied source archives. FFmpeg contains components under LGPL, GPL,
MIT/X11/BSD and compatible licenses; its included LICENSE.md explains the
combination. The GPL license and other notices are included unabridged here.

## Corresponding source and rebuilding

The `sources` directory is supplied with the application and contains the exact,
unmodified FFmpeg and x264 source archives, the NASM build-tool source, pinned
SHA-256 checksums and the build script. No source patches are applied.
FFmpeg's upstream PGP signature was checked against release key
FCF986EA15E6E293A5644F10B4322F04D67658D8; the signature and public key are included.

The same source kit is provided alongside the installers on
https://github.com/sexyfeifan/Kocpy/releases . You do not need a separate source
request or a proprietary build service to obtain it.

From a Kocpy source checkout on macOS, install Xcode command-line tools, Node.js
and pkg-config, then run:

```
node scripts/build-media-runtime.mjs arm64
node scripts/build-media-runtime.mjs x64
```

Alternatively, extract the standalone source kit and run
`node sources/build-media-runtime.mjs arm64` (or `x64`) from its root.
No Kocpy checkout is needed. To verify its inputs without compiling, run
`node sources/build-media-runtime.mjs arm64 sources --verify-sources`.
The script compiles NASM locally and uses Apple's system SDK/libraries, not linked
Homebrew libraries. An x64 binary can be smoke-tested on Apple Silicon with
Rosetta; that is not an Intel hardware test. Build trees are retained in a new
temporary directory and outputs under `work/media-built/`. Compiler/SDK details,
configuration and binary digests are in the `build-info-*.json` files.

Schema 2 records the exact compiler-output digest as `unsignedSha256`; that
output may already contain an Apple linker ad-hoc signature. The build script
strictly verifies and removes an existing compiler signature before applying
a fixed `com.kocpy.media.ffmpeg.<arch>` ad-hoc signature
with hardened runtime and no timestamp, verifies it, and freezes the complete
signed file digest as `sha256`. This is a declared build step, not a replacement
of an expected checksum after packaging. The App packager preserves those exact
signed media bytes and verifies them again after signing the App. This media
policy supports ad-hoc releases only; Developer ID and notarization are refused
until their own provenance and signing process is implemented and verified.

SIMD remains enabled. H.264 encoding uses libx264; ProRes Proxy uses prores_ks.
Optional third-party codecs from prior vendor builds are not included. Network
input protocols are disabled; Kocpy's media operations accept local files.
This notice is not a patent license or a claim of App Store distribution approval.
No warranty is provided; see the license terms.

Upstream sources: https://ffmpeg.org/ · https://code.videolan.org/videolan/x264 ·
https://www.nasm.us/
