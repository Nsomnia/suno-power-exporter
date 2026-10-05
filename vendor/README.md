# `vendor/` — third-party audio encoders

These two files are **unmodified upstream builds**, shipped inside the extension so that
MP3 and Ogg Vorbis export work without loading remote code.

Manifest V3's default CSP for extension pages is `script-src 'self'`, and the Chrome Web
Store policy bans remotely hosted code outright. That is why the third-party "Unlimited
Suno Downloads" userscript cannot be reproduced here: it does
`importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js')` inside a Blob
worker. Vendoring is the only way to do this legitimately, so both encoders live here,
are loaded by `offscreen/offscreen.js` from a local relative path, and are loaded as
ordinary classic `<script>` elements.

Do **not** minify, re-bundle, patch or concatenate these files. The SHA-256 values below
are only meaningful while the bytes are exactly what upstream published, and `vendor/`
being a drop-in replacement is what discharges the LGPL obligation described further down.

---

## `lame.all.js` — MP3

| | |
|---|---|
| Version | `lamejs` **1.2.1** (the exact artifact the userscript references) |
| Source URL | <https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js> |
| Upstream project | <https://github.com/zhuker/lamejs> |
| SHA-256 | `026bd88846040f357a937cd85821a48492a362eff0812cda734f23fca55fea3b` |
| Size | 530,087 bytes |
| Global it defines | `lamejs` (a function), with `lamejs.Mp3Encoder` |
| Licence | **LGPL-3.0** — see `LICENSE-lamejs.txt` |
| Retrieved | 2026-10-04 |

**Provenance check.** Downloaded from jsDelivr, then independently compared against the
same file extracted from the npm tarball for `lamejs@1.2.1`
(`https://registry.npmjs.org/lamejs/1.2.1` → `dist.tarball`). Both hashes are
`026bd888…a3b` and both are 530,087 bytes: **byte-identical**, so the CDN is not serving
anything the npm package does not.

`lame.all.js` is a browserified bundle of the `src/js` tree (it begins with a top-level
`function lamejs() { … }` and calls itself, so a classic `<script>` tag defines the
global). It is pure JavaScript: no WebAssembly, no `wasm-unsafe-eval` needed, no
secondary file to fetch.

### Licence position — LGPL-3.0, and what it obliges us to do

* `package.json` inside the npm tarball declares `"license": "LGPL-3.0"`, and the npm
  registry metadata for 1.2.1 agrees. That is the authoritative statement of the terms.
* The `LICENSE` file shipped in the tarball — saved verbatim as
  `vendor/LICENSE-lamejs.txt` — is **not** the licence text. It is the LAME FAQ answer
  "Can I use LAME in my commercial program?", which says the LGPL applies, names three
  conditions, and **does not name an LGPL version**. So the version number comes from the
  package metadata, not from the shipped licence file. Both are recorded here rather than
  quietly picking one.

Practical implications for a distributed extension:

1. **Dynamic linking, which is what this build does.** The library is never linked into
   `offscreen/offscreen.js`. It stays a separate work, loaded at runtime by
   `loadVendoredScript()` injecting `<script src="../vendor/lame.all.js">` into the
   offscreen document. That satisfies LGPL-3.0 §4's requirement to use a "suitable
   mechanism for relinking" / separable work.
2. **The user must be able to replace or remove the library.** Because it is a plain
   file in the extension directory, a user can delete `vendor/lame.all.js` or substitute
   another build without recompiling, patching or relinking anything. Nothing in the
   extension is statically bound to it.
3. **Modifications, if we ever make any, must be released under the LGPL.** We ship it
   byte-identical, so this does not currently apply. It is the reason the files must not
   be "improved" in place.
4. **Attribution.** LGPL-3.0 §4(d)/(e) and §5 require conveying the licence and stating
   that the library is under the LGPL. This README plus `LICENSE-lamejs.txt` in the
   extension directory is that notice; the UI copy names the library and its version.
5. **No warranty.** LGPL-3.0 §15 and MIT-style disclaimers aside, the encoders are
   third-party and are covered by their own terms, not this extension's.

Residual uncertainty, stated plainly: the tarball's own `LICENSE` file names no LGPL
version, so "LGPL-3.0" rests on `package.json` and the npm registry rather than on the
licence text shipped beside the code. We did not independently audit the origin of
lamejs's JS port against the upstream LAME C sources. None of that blocks shipping, but if
this ever goes to a legal review, those are the two questions to ask.

---

## `OggVorbisEncoder.js` — Ogg Vorbis

| | |
|---|---|
| Version | `higuma/ogg-vorbis-encoder-js` @ **`7a872423f416e330e925f5266d2eb66cff63c1b6`** |
| Source URL | <https://cdn.jsdelivr.net/gh/higuma/ogg-vorbis-encoder-js@master/lib/OggVorbisEncoder.js> |
| Upstream project | <https://github.com/higuma/ogg-vorbis-encoder-js> |
| SHA-256 | `5a9f749ab0f84da2292bd68b0e906422378428aea2e298fd116e8a1696da179b` |
| Size | 2,358,493 bytes |
| Global it defines | `OggVorbisEncoder` (a constructor function) |
| Licence | **MIT** for the JS wrapper, plus the **Xiph BSD** licence for the embedded libogg/libvorbis — see `LICENSE-OggVorbisEncoder.txt` |
| Retrieved | 2026-10-04 |

### Pinning `@master`, because the project has no releases

This project publishes **no tags and no GitHub releases** (verified against the GitHub
API on 2026-10-04), so `@master` cannot be replaced with a version number. It is pinned
by content instead:

* `master` resolves to commit **`7a872423f416e330e925f5266d2eb66cff63c1b6`**, whose
  committer date is **2016-06-12** — the branch has not moved in nine years, so `@master`
  is stable in practice, but a future force-push is not impossible.
* `git hash-object` on the downloaded file yields
  `c6508ae1031b9950a706f41f98a5f4fdd40363c1`, which is **exactly** the git blob SHA the
  GitHub API reports for `lib/OggVorbisEncoder.js` at that commit.
  **Byte-identical to upstream.**

### Licence position — MIT plus Xiph BSD, not BSD-3-Clause

The task this file came from described this project as BSD-3-Clause. That is **not what
upstream says**, and the shipped file wins:

* The repository's licence file is `LICENSE.txt` (not `LICENSE`), and it is the **MIT
  Licence**, © 2015 Yuji Miyane. GitHub's own licensee detector agrees (`spdx_id: MIT`).
  It is saved verbatim as `vendor/LICENSE-OggVorbisEncoder.txt`.
* The README states a **split** licence, and the split is real rather than a formality:
  > libogg and libvorbis are released under Xiph's BSD-like license below. JavaScript-converted
  > part of this library follows the same license. […] C and JavaScript wrapper API part of this
  > library is released under MIT licence.

  So the Emscripten-compiled libogg/libvorbis C code inside `OggVorbisEncoder.js` is under
  the 3-clause BSD text at <http://www.xiph.org/licenses/bsd/>, and the JS wrapper around
  it is MIT.

Both are permissive, permissive-compatible, and both require only that the copyright
notice and permission notice travel with the source. Both notices are in this directory.
Practical difference from LGPL: **there is no relinking, no source-offer and no
modification-release obligation.** Shipping a byte-identical copy with its licence beside
it discharges the whole obligation.

Residual uncertainty: the Xiph BSD text is referenced by URL in the README and is not
reproduced in this repository, so it is not on disk here. It is a well-known and stable
licence, and the attribution requirement is met by `LICENSE-OggVorbisEncoder.txt` plus this
file, but a distributor who wants the libogg/libvorbis BSD text physically in the package
should add it. We did not verify that `libvorbis` embeds no third-party code with its own
separate terms.

---

## API notes that will bite anyone editing `offscreen/offscreen.js`

These two libraries do **not** share an interface, and the Ogg one fails silently if you
assume they do. Both facts are asserted in the code.

**`lamejs.Mp3Encoder`** — matches the usual expectation:

```js
const enc = new lamejs.Mp3Encoder(channels, sampleRate, kbps); // Int8Array out
enc.encodeBuffer(left, right);   // Int8Array
enc.flush();                     // Int8Array
```

Verified by running 0.5 s of 48 kHz stereo sine through it: 12,672 bytes, valid MPEG
frame sync (`0xFF 0xFB`).

**`OggVorbisEncoder`** — does **not**:

```js
const enc = new OggVorbisEncoder(sampleRate, numChannels, quality); // constructor matches
enc.encode([leftFloat32, rightFloat32]);  // returns UNDEFINED — pushes onto enc.oggBuffers
enc.flush();                              // DOES NOT EXIST -> TypeError
enc.finish('audio/ogg');                  // this is the flush; returns a Blob
```

Two traps, both of which made OGG export impossible before they were fixed:

1. `encode()` returns nothing. A `if (buf && buf.length) parts.push(buf)` loop — the
   shape `lamejs` requires — silently discards **every** page.
2. There is no `flush()`. The prototype members are `encode`, `finish`, `cancel`,
   `cleanup` and `process`. `finish(mimeType)` processes the tail block, returns the whole
   stream as a `Blob`, and frees the encoder.

Verified by running the same 0.5 s sine through the corrected path: 6,280 bytes starting
`OggS`.

`OggVorbisEncoder.js` is an **asm.js** build (one `use asm` directive, zero
`WebAssembly` references) with its memory initialiser embedded, so it needs no `.mem`
sidecar file, no network fetch, and no `wasm-unsafe-eval` CSP relaxation.
`offscreen/offscreen.html` declares `default-src 'none'; script-src 'self'`, which permits
a `chrome-extension:`-origin `<script src>` and nothing else — exactly what is used here.
A `<script>` injected by an extension page into that same page is same-origin, so
`manifest.json` needs no `web_accessible_resources` entry for these files.

## Re-verifying these files

```sh
shasum -a 256 vendor/lame.all.js vendor/OggVorbisEncoder.js
node --check vendor/lame.all.js
node --check vendor/OggVorbisEncoder.js   # prints a harmless V8 asm.js warning
```

Expected hashes are the ones in the tables above. If either differs, the file has been
modified and the LGPL-3.0 modification-release obligation in `LICENSE-lamejs.txt` applies
to the MP3 side.
