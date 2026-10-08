#!/bin/sh
#
# check-build.sh - pre-flight gate for the Suno Master Utility extension.
#
# Chrome aborts loading an unpacked extension on the FIRST bad content-script
# file, and it reports several very different root causes with the same
# "isn't UTF-8 encoded" message. That makes the failure expensive to diagnose
# after the fact, so everything below is asserted up front.
#
# Notably: `iconv -f UTF-8 -t UTF-8` and Python's strict codec BOTH accept
# U+FFFE/U+FFFF, but Chrome's base::IsStringUTF8 rejects them. See
# base/strings/utf_string_conversion_utils.h -> IsValidCharacter, which
# excludes non-characters (U+FDD0..U+FDEF and every code point ending in
# 0xFFFE/0xFFFF), unlike IsValidCodepoint which allows them. A file can
# therefore be "valid UTF-8" by every standard tool and still be refused by
# Chrome. That exact case broke lib/db.js, so the strict check below is not
# optional.
#
# -----------------------------------------------------------------------------
# VENDORED THIRD-PARTY CODE
# -----------------------------------------------------------------------------
# vendor/ holds two upstream encoder bundles (2.8 MB between them) plus their
# licence notices, loaded at runtime by offscreen/offscreen.js via <script src>.
# They are audited here too: the byte audit, the UTF-8 gate and a parse attempt
# all used to skip them, which meant the largest JavaScript in the package was
# the only JavaScript nobody checked.
#
# The SHA-256 gate below is the strong one. vendor/README.md records a hash per
# encoder and states that the hashes are only meaningful while the bytes match
# upstream; vendor/ being a drop-in replacement is what discharges the LGPL-3.0
# obligation. The hashes are PARSED OUT OF THAT FILE rather than restated here,
# so the two cannot drift apart, and a missing or unparseable entry is a
# failure rather than a silent skip. It catches CRLF rewriting, re-minification,
# patching and botched re-downloads in one shot.
#
# `.gitattributes` marks vendor/** -text so those bytes survive checkout
# unchanged on every platform; this check is what tells you when they did not.
#
# Requirements: POSIX sh, node, python3. iconv is used when present.
#
# Usage:  sh scripts/check-build.sh
# Exit:   0 = all checks pass, 1 = at least one failure.

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

# Every file the build loads, listed explicitly. Keep in sync with
# manifest.json; the manifest path check below will catch a mismatch.
BUILD_FILES="
manifest.json
lib/db.js
lib/crypto.js
lib/drm.js
lib/tagger.js
lib/lyrics.js
lib/audio.js
lib/api.js
lib/suno.js
background/background.js
background/parts/03-errors.js
background/parts/06-messaging.js
background/parts/15-quota.js
content/content.js
popup/popup.js
options/options.js
side_panel.js
offscreen/offscreen.js
popup/popup.html
side_panel.html
options/options.html
offscreen/offscreen.html
popup/popup.css
content/content.css
options/options.css
icons/icon16.png
icons/icon48.png
icons/icon128.png
"

# Third-party code and its notices. Deliberately NOT in BUILD_FILES: none of
# these paths appear in manifest.json (offscreen.js injects <script src> at
# runtime, so the manifest path check cannot police them), and BUILD_FILES is
# documented above as the list to keep in sync with the manifest.
#
# VENDOR_ENCODERS is the two integrity-gated bundles.
# VENDOR_FILES adds the notices, which get the existence and UTF-8 gates below
# too: shipping these libraries without LICENSE-lamejs.txt and
# LICENSE-OggVorbisEncoder.txt breaks the terms they are redistributed under,
# and a licence file mangled by an editor is still a broken redistribution.
VENDOR_INDEX="vendor/README.md"
VENDOR_ENCODERS="
vendor/lame.all.js
vendor/OggVorbisEncoder.js
"
VENDOR_NOTICES="
vendor/LICENSE-lamejs.txt
vendor/LICENSE-OggVorbisEncoder.txt
$VENDOR_INDEX
"

# Every path the existence, byte, UTF-8 and parse loops below walk.
AUDIT_FILES="$BUILD_FILES $VENDOR_ENCODERS $VENDOR_NOTICES"

fails=0
checks=0

pass() {
	checks=$((checks + 1))
	printf '  ok    %s\n' "$1"
}

fail() {
	checks=$((checks + 1))
	fails=$((fails + 1))
	printf '  FAIL  %s\n' "$1"
	if [ $# -gt 1 ]; then
		printf '%s\n' "$2" | sed 's/^/          /'
	fi
	return 0
}

note() { printf '  note  %s\n' "$1"; }

# --- dependency check ------------------------------------------------------
for tool in python3 node; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		printf 'ERROR: %s is required but not on PATH.\n' "$tool" >&2
		exit 1
	fi
done

if command -v iconv >/dev/null 2>&1; then
	UTF8_ENGINE="iconv"
else
	UTF8_ENGINE="python3"
	note "iconv not found; falling back to python3 for UTF-8 validation"
fi

# Scratch file for tool stderr. Capturing stderr through a pipe is not
# reliable across shells, so every tool writes here and we read it back.
errfile=$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/check-build.$$")
trap 'rm -f "$errfile"' EXIT INT TERM

printf '\n== build check: %s\n' "$ROOT"
printf '== UTF-8 engine: %s, node: %s, python3: %s\n' \
	"$UTF8_ENGINE" "$(node --version)" "$(python3 --version 2>&1)"

# --- 1. every build file exists -------------------------------------------
# Covers AUDIT_FILES, i.e. the extension's own files AND vendor/: the two
# encoders plus their licence notices and the integrity index.
printf '\n-- existence\n'
for f in $AUDIT_FILES; do
	if [ -f "$f" ]; then
		pass "exists  $f"
	else
		fail "missing  $f"
	fi
done

# --- 2. byte-level audit --------------------------------------------------
# Needs real byte inspection (BOM, NUL, control chars, non-characters), so it
# runs as one python3 pass over the text files. vendor/ is included: the
# encoders are loaded as classic scripts by an extension page, so Chrome applies
# exactly the same UTF-8 rules to them as to our own JavaScript.
printf '\n-- byte audit (BOM, NUL, control chars, Chrome-strict non-characters)\n'
byte_out=$(python3 - $AUDIT_FILES <<'PY' 2>&1
import sys

TEXT = [f for f in sys.argv[1:] if not f.endswith(".png")]


def valid_codepoint(cp):
    """base::IsValidCodepoint - allows non-characters."""
    return (0 <= cp < 0xD800) or (0xE000 <= cp <= 0x10FFFF)


def valid_character(cp):
    """base::IsValidCharacter - used by base::IsStringUTF8; rejects
    non-characters U+FDD0..U+FDEF and anything ending in 0xFFFE/0xFFFF."""
    return ((0 <= cp < 0xD800) or (0xE000 <= cp < 0xFDD0) or
            (0xFDEF < cp <= 0x10FFFF and (cp & 0xFFFE) != 0xFFFE))


def walk(raw, pred):
    """Mimic ICU CBU8_NEXT in strict mode plus Chromium's per-codepoint
    Validator. Validates continuation bytes, overlong forms, surrogates and
    out-of-range lead bytes, the way U8_NEXT(strict=true) does."""
    i, n = 0, len(raw)
    while i < n:
        b = raw[i]
        if b < 0x80:
            cp, i = b, i + 1
        elif b < 0xC2:  # 0x80-0xBF stray continuation, 0xC0/0xC1 overlong
            return None, ("stray continuation byte 0x%02X" % b if b < 0xC0
                          else "overlong 2-byte lead 0x%02X" % b) + \
                " at offset %d" % i
        elif b < 0xE0:
            if i + 1 >= n:
                return None, "truncated 2-byte sequence at offset %d" % i
            c1 = raw[i + 1]
            if not 0x80 <= c1 <= 0xBF:
                return None, ("expected continuation byte, got 0x%02X at "
                              "offset %d" % (c1, i + 1))
            cp = ((b & 0x1F) << 6) | (c1 & 0x3F)
            i += 2
        elif b < 0xF0:
            if i + 2 >= n:
                return None, "truncated 3-byte sequence at offset %d" % i
            c1, c2 = raw[i + 1], raw[i + 2]
            if not (0x80 <= c1 <= 0xBF and 0x80 <= c2 <= 0xBF):
                return None, ("bad continuation bytes %02X %02X at offset %d"
                              % (c1, c2, i + 1))
            cp = ((b & 0x0F) << 12) | ((c1 & 0x3F) << 6) | (c2 & 0x3F)
            if cp < 0x800:
                return None, "overlong 3-byte sequence at offset %d" % i
            i += 3
        elif b < 0xF5:
            if i + 3 >= n:
                return None, "truncated 4-byte sequence at offset %d" % i
            c1, c2, c3 = raw[i + 1], raw[i + 2], raw[i + 3]
            if not (0x80 <= c1 <= 0xBF and 0x80 <= c2 <= 0xBF and
                    0x80 <= c3 <= 0xBF):
                return None, ("bad continuation bytes %02X %02X %02X at "
                              "offset %d" % (c1, c2, c3, i + 1))
            cp = (((b & 0x07) << 18) | ((c1 & 0x3F) << 12) |
                  ((c2 & 0x3F) << 6) | (c3 & 0x3F))
            if cp < 0x10000:
                return None, "overlong 4-byte sequence at offset %d" % i
            if cp > 0x10FFFF:
                return None, "code point above U+10FFFF at offset %d" % i
            i += 4
        else:
            return None, "invalid lead byte 0x%02X at offset %d" % (b, i)
        if not pred(cp):
            return cp, "U+%04X" % cp
    return True, ""


problems = []
for path in TEXT:
    try:
        raw = open(path, "rb").read()
    except OSError as exc:
        problems.append("%s: cannot read (%s)" % (path, exc))
        continue

    if raw.startswith(b"\xef\xbb\xbf"):
        problems.append("%s: UTF-8 BOM present (EF BB BF) - strip it" % path)
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        problems.append("%s: UTF-16 BOM present - file is not UTF-8" % path)

    nul = raw.count(b"\x00")
    if nul:
        problems.append("%s: %d NUL byte(s)" % (path, nul))

    ctrl = sorted({b for b in raw if b < 0x20 and b not in (0x09, 0x0A, 0x0D)})
    if ctrl:
        problems.append("%s: stray C0 control byte(s) %s" % (
            path, " ".join("0x%02X" % b for b in ctrl)))

    cp, why = walk(raw, valid_codepoint)
    if cp is None:
        problems.append("%s: malformed UTF-8 - %s" % (path, why))
        continue
    if cp is True:
        cp2, why2 = walk(raw, valid_character)
        if cp2 is not True:
            line = raw[:raw.index(
                b"\xef\xbf\xbf" if cp2 == 0xFFFF else b"\xef\xbf\xbe")] \
                .count(b"\n") + 1 if cp2 in (0xFFFE, 0xFFFF) else 0
            problems.append(
                "%s: contains Unicode non-character %s%s - valid UTF-8, but "
                "Chrome's base::IsStringUTF8 rejects it; use the \\uXXXX escape"
                % (path, why2, (" (line %d)" % line) if line else ""))
    else:
        problems.append("%s: invalid codepoint %s" % (path, why))

if problems:
    print("  %d problem(s):" % len(problems))
    for p in problems:
        print("    - %s" % p)
    sys.exit(1)

print("  %d text files: no BOM, no NUL, no stray control chars," % len(TEXT))
print("  and no Unicode non-characters (Chrome-strict base::IsStringUTF8).")
PY
)
byte_rc=$?
printf '%s\n' "$byte_out"
if [ "$byte_rc" -eq 0 ]; then
	pass "byte audit clean"
else
	fail "byte audit found problems (listed above)"
fi

# --- 3. UTF-8 validity ----------------------------------------------------
# iconv is the primary gate; python3 is the fallback when iconv is absent.
# Exit status is the signal; stderr goes to the scratch file. This loop covers
# vendor/ too, which is how the two licence notices are proven readable text.
printf '\n-- UTF-8 validity\n'
for f in $AUDIT_FILES; do
	case "$f" in
	*.png) continue ;; # binary icon, not text
	esac
	[ -f "$f" ] || continue

	if [ "$UTF8_ENGINE" = "iconv" ]; then
		if iconv -f UTF-8 -t UTF-8 <"$f" >/dev/null 2>"$errfile"; then
			pass "utf-8  $f"
		else
			fail "not valid UTF-8  $f" "$(head -1 "$errfile")"
		fi
	else
		if python3 -c 'import sys;open(sys.argv[1],encoding="utf-8",errors="strict").read()' \
			"$f" >/dev/null 2>"$errfile"; then
			pass "utf-8  $f"
		else
			fail "not valid UTF-8  $f" "$(tail -1 "$errfile")"
		fi
	fi
done

# --- 4. vendored encoder integrity (SHA-256, from vendor/README.md) -------
# The strongest check in this script. The expected digests are read out of the
# table in vendor/README.md rather than restated here, so the file on disk and
# the documented record cannot drift apart, and a missing / malformed /
# hash-less entry for an encoder is a FAILURE rather than a silent skip.
printf '\n-- vendored encoders (SHA-256 vs %s)\n' "$VENDOR_INDEX"
if [ -f "$VENDOR_INDEX" ]; then
	for f in $VENDOR_ENCODERS; do
		[ -f "$f" ] || continue
		hash_out=$(python3 - "$f" "$VENDOR_INDEX" <<'PY' 2>&1
import hashlib
import os
import re
import sys

target, index = sys.argv[1], sys.argv[2]
name = os.path.basename(target)

if not os.path.isfile(index):
    print("  %s is missing - nothing to verify %s against" % (index, target))
    sys.exit(1)
try:
    doc = open(index, encoding="utf-8").read()
except (OSError, UnicodeDecodeError) as exc:
    print("  cannot read %s: %s" % (index, exc))
    sys.exit(1)

# Scope the lookup to this encoder's own "## `<file>` ..." section, so a digest
# can never be picked up from the wrong table. Splitting on "## " (not "###")
# keeps subsections inside the section they belong to.
section = None
for chunk in re.split(r"(?m)^##[ \t]+", doc):
    head = chunk.split("\n", 1)[0]
    if re.search(r"`" + re.escape(name) + r"`", head):
        section = chunk
        break

if section is None:
    print("  %s has no \"## `%s`\" section - no recorded digest to check"
          % (index, name))
    sys.exit(1)

row = re.search(r"(?m)^\|\s*SHA-256\s*\|\s*`([0-9a-fA-F]{64})`\s*\|", section)
if row is None:
    print("  no parseable \"| SHA-256 | `<64 hex>` |\" row in the \"%s\""
          " section of %s" % (name, index))
    sys.exit(1)
want = row.group(1).lower()

size_row = re.search(r"(?m)^\|\s*Size\s*\|\s*([0-9,]+)", section)
want_size = int(size_row.group(1).replace(",", "")) if size_row else None

digest = hashlib.sha256()
with open(target, "rb") as fh:
    for block in iter(lambda: fh.read(1 << 20), b""):
        digest.update(block)
got = digest.hexdigest()
size = os.path.getsize(target)

print("  %s" % target)
print("    recorded  sha-256 %s  %s B   [%s]" %
      (want, want_size if want_size is not None else "?", index))
print("    on disk   sha-256 %s  %d B" % (got, size))

bad = False
if got != want:
    print("    MISMATCH - this file is no longer byte-identical to upstream.")
    print("      expected %s" % want)
    print("      actual   %s" % got)
    print("      Usual causes: EOL/CRLF rewriting, re-minification, patching,")
    print("      or a botched re-download. Do not patch these files in place;")
    print("      see vendor/README.md and .gitattributes.")
    bad = True
if want_size is not None and size != want_size:
    print("    SIZE MISMATCH - expected %d B, found %d B (truncation?)" %
          (want_size, size))
    bad = True
if bad:
    sys.exit(1)

print("    byte-identical to the upstream artifact recorded in %s" % index)
PY
		)
		hash_rc=$?
		printf '%s\n' "$hash_out"
		if [ "$hash_rc" -eq 0 ]; then
			pass "sha-256 matches $VENDOR_INDEX  $f"
		else
			fail "vendored encoder not byte-identical  $f (listed above)"
		fi
	done
else
	fail "missing  $VENDOR_INDEX (cannot verify the encoders without it)"
fi

# --- 4b. duplicated stopReason maps must stay identical --------------------
# The sync stopReason -> English map is deliberately duplicated, byte-identically,
# in the popup, the side panel and the content script: content scripts and
# extension pages share no module graph (docs/ARCHITECTURE.md:1467-1472), so
# there is nowhere to put ONE copy that all three can read.
#
# The cost of that decision is that nothing but discipline keeps them equal, and
# a stopReason added to one file and forgotten in the other two produces two
# surfaces describing the same failure differently — which is precisely the class
# of bug this repo's completeness contract exists to prevent. So it is checked.
#
# The `advisory` key is intentionally absent from all three and is not compared:
# it is a non-error severity carried alongside stopReason, not a reason itself.
printf '\n-- duplicated stopReason maps (popup / side panel / content script)\n'
stopreason_out=$(python3 - <<'PY' 2>&1
import re, sys

TARGETS = [("popup/popup.js", "popup"), ("side_panel.js", "side panel"),
           ("content/content.js", "content script")]
# A map entry looks like:  key: 'text',   with single quotes and an escaped one.
ENTRY = re.compile(r"^([a-z_]+):\s*'((?:[^'\\]|\\.)*)'\s*,?\s*$")


def extract(path):
    """Return {key: value} for the stopReason map, or None if not found.

    Located by a key every map must carry, then read to the closing brace, rather
    than by line number: line numbers move with every edit above, which is how a
    check like this silently stops checking anything.
    """
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError as exc:
        print("  cannot read %s: %s" % (path, exc))
        sys.exit(1)
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^\s*complete:\s*'the crawl finished cleanly'", line):
            start = i
            break
    if start is None:
        return None
    # Read CONSECUTIVE entry lines, not a brace-balanced span. The map's entries
    # contain no braces, so counting them leaves depth at 0 and a balanced scan
    # stops after the FIRST key — which compares one trivial key across three
    # files and passes no matter how far they have drifted. Verified: that bug
    # shipped in this check's first draft and silently passed an injected drift.
    out = {}
    for line in lines[start:]:
        stripped = line.strip()
        if not stripped:
            continue
        m = ENTRY.match(stripped)
        if not m:
            break  # the run of entries has ended
        out[m.group(1)] = m.group(2)
    return out or None


maps = {}
bad = False
for path, label in TARGETS:
    got = extract(path)
    if not got:
        print("  FAIL %-44s no stopReason map found" % label)
        bad = True
        continue
    maps[label] = got
    print("    ok   %-44s %d reasons" % (label, len(got)))

if len(maps) > 1:
    ref_label = next(iter(maps))
    ref = maps[ref_label]
    for label, got in maps.items():
        if label == ref_label:
            continue
        only_ref = sorted(set(ref) - set(got))
        only_got = sorted(set(got) - set(ref))
        drift = sorted(k for k in set(ref) & set(got) if ref[k] != got[k])
        if only_ref or only_got or drift:
            bad = True
            print("  FAIL %s differs from %s:" % (label, ref_label))
            for k in only_ref:
                print("      missing in %s: %s" % (label, k))
            for k in only_got:
                print("      not in %s: %s" % (k, ref_label))
            for k in drift:
                print("      wording differs for %s:" % k)
                print("        %s: %s" % (ref_label, ref[k]))
                print("        %s: %s" % (label, got[k]))
        else:
            print("    ok   %-44s identical to %s" % (label, ref_label))
if bad:
    sys.exit(1)
PY
)
	if [ $? -eq 0 ]; then
		pass "stopReason maps are byte-identical across all three surfaces"
	else
		printf '%s\n' "$stopreason_out"
		fail "stopReason maps have drifted; a surface will describe one failure differently"
		printf '%s\n' "$stopreason_out" | grep -E '^\s+ok' || true
	fi

# --- 4c. extracted parts must not collide with the monolith ----------------
# THE SILENT HAZARD OF THE PART MECHANISM, reproduced by execution:
#
#   the worker declares  function log() {}
#   a part declares      function log() {}   ->  globalThis.log is now the PART
#
# No error. No warning. `node --check` passes, because it validates each file in
# isolation and cannot see that two files claim the same global name. Every
# monolith call site silently starts calling the part version instead, and the
# only symptom is that logging (or anything else a part shadows) behaves wrong
# in a way nothing points at.
#
# `const` behaves differently and worse-looking but better-caught: two parts
# declaring the same `const` throws SyntaxError at load, so it is loud. It is the
# `function` case that is invisible, and it is the only one worth guarding.
#
# Top-level declarations are matched at column 0. That is exact for this tree:
# every part and the worker declare their top-level functions flush left, and
# anything indented belongs to a function or block body and cannot collide.
printf '\n-- extracted parts: no global name collisions\n'
parts_out=$(python3 - <<'PY' 2>&1
import glob, os, re, sys

CH, Q1, Q2 = chr(92), chr(39), chr(34)
# Declarations that claim a name in the shared global scope.
DECL = re.compile(
    r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"      # function foo(
    r"|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)"          # const foo =
    r"|^class\s+([A-Za-z_$][\w$]*)"                      # class Foo
)


def top_level_names(path):
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError as exc:
        print("  cannot read %s: %s" % (path, exc))
        sys.exit(1)
    names = {}
    for i, line in enumerate(lines, 1):
        if not line or line[0].isspace():
            continue  # indented: inside a function or block, cannot collide
        m = DECL.match(line)
        if not m:
            continue
        name = next(g for g in m.groups() if g)
        names.setdefault(name, i)
    return names


worker = "background/background.js"
parts = sorted(glob.glob("background/parts/*.js"))
if not parts:
    print("    ok   no parts to compare yet")
    sys.exit(0)

worker_names = top_level_names(worker)
bad = False
print("    ok   %-44s %d top-level names" % (worker, len(worker_names)))

seen = {}
for p in parts:
    names = top_level_names(p)
    print("    ok   %-44s %d top-level names" % (p, len(names)))
    for name, line in sorted(names.items()):
        # part vs monolith
        if name in worker_names:
            bad = True
            print("  FAIL %s:%d declares %r, which %s:%d also declares"
                  % (p, line, name, worker, worker_names[name]))
            print("        a part redeclaring a monolith function SILENTLY REPLACES it")
            continue
        # part vs part
        if name in seen:
            other, oline = seen[name]
            bad = True
            print("  FAIL %s:%d and %s:%d both declare %r" % (p, line, other, oline, name))
        else:
            seen[name] = (p, line)

if bad:
    sys.exit(1)
print("    ok   no part shadows a monolith or sibling name")
PY
)
	if [ $? -eq 0 ]; then
		pass "extracted parts declare no colliding global names"
	else
		printf '%s\n' "$parts_out" | grep -vE '^\s+ok' || true
		printf '%s\n' "$parts_out" | grep -E '^\s+ok' || true
		fail "an extracted part shadows a global name; this fails SILENTLY at runtime"
	fi

# --- 4d. every extracted part is registered, built, and probed ---------------
# Two ways a part can exist on disk and still be wrong:
#
#   P1  it is not listed in BUILD_FILES, so it is never syntax-checked and a
#       parse error in it ships silently. The manifest/importScripts check
#       proves the path EXISTS; nothing proved it is BUILT.
#   P3  the worker's MISSING_PARTS probe names a symbol the part does not
#       actually export, so the probe passes while the real export is missing —
#       a health check that reports healthy on a broken part. That is the same
#       failure shape as the parity-check bug, one level up.
printf '\n-- extracted parts: registered in BUILD_FILES and probed honestly\n'
partsreg_out=$(python3 - "$BUILD_FILES" <<'PY' 2>&1
import glob, re, sys

build_files = set(sys.argv[1].split())
parts = sorted(glob.glob("background/parts/*.js"))
bad = False

if not parts:
    print("    ok   no parts on disk yet")
    sys.exit(0)

# P1: registered for building.
for p in parts:
    if p in build_files:
        print("    ok   %-44s in BUILD_FILES" % p)
    else:
        bad = True
        print("  FAIL %-44s NOT in BUILD_FILES (never syntax-checked)" % p)

# P3: every MISSING_PARTS probe names a symbol its part really exports.
Q = chr(39)
try:
    worker = open("background/background.js", encoding="utf-8").read()
except OSError as exc:
    print("  cannot read worker: %s" % exc)
    sys.exit(1)

probes = re.findall(r"MISSING_PARTS\.push\(" + Q + r"([^" + Q + r"]+)" + Q + r"\)", worker)
if not probes:
    print("    ok   worker declares no MISSING_PARTS probes")
for raw in probes:
    m = re.match(r"(.+?)\s*\((.+?)\)", raw)
    if not m:
        print("  FAIL unparseable MISSING_PARTS probe: %s" % raw)
        bad = True
        continue
    path, symbol = m.group(1).strip(), m.group(2).strip()
    if path not in parts:
        print("  FAIL probe names %s, which is not a part on disk" % path)
        bad = True
        continue
    try:
        text = open(path, encoding="utf-8").read()
    except OSError as exc:
        print("  cannot read %s: %s" % (path, exc))
        sys.exit(1)
    # An export block is `globalThis.SMU<Name> = { a, b, c };` (shorthand) or
    # `{ a: 1, b: 2 }`. Split on commas rather than scanning for delimiters: the
    # outer match already consumed the opening brace, so the FIRST exported name
    # has no preceding `{` or `,` and a delimiter-scan silently drops exactly
    # the symbol most likely to be probed. It did — the check reported a false
    # positive on the one part that exports the probed symbol.
    exported = set()
    for block in re.findall(r"globalThis\.SMU\w*\s*=\s*\{(.*?)\}\s*;", text, re.S):
        for item in block.split(","):
            name = item.split(":")[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
                exported.add(name)
    if symbol in exported:
        print("    ok   %-44s probe names exported %s" % (path, symbol))
    else:
        bad = True
        print("  FAIL %-44s probe names %s, which it does NOT export" % (path, symbol))
        print("        probe reports healthy on a part missing the symbol")

sys.exit(1 if bad else 0)
PY
)
	if [ $? -eq 0 ]; then
		pass "every extracted part is built and its MISSING_PARTS probe is honest"
	else
		printf '%s\n' "$partsreg_out" | grep -vE '^\s+ok' || true
		printf '%s\n' "$partsreg_out" | grep -E '^\s+ok' || true
		fail "an extracted part is unregistered, or its health probe names a symbol it does not export"
	fi

# --- 5. JavaScript syntax -------------------------------------------------
printf '\n-- JavaScript syntax (node --check)\n'
for f in $BUILD_FILES; do
	case "$f" in
	*.js) ;;
	*) continue ;;
	esac
	[ -f "$f" ] || continue

	if node --check "$f" >/dev/null 2>"$errfile"; then
		pass "parses  $f"
	else
		fail "syntax error  $f" "$(head -3 "$errfile")"
	fi
done

# The two vendored bundles get their own handling instead of riding the loop
# above, because neither is "our" code:
#
#   * vendor/OggVorbisEncoder.js is an asm.js build. It parses, and V8 prints
#     "Invalid asm.js: Expected shift of word size" on stderr while still
#     exiting 0. That message is a COMPILED-MODE ADVISORY about the optimised
#     integer range of one shift inside libvorbis - not a syntax error, and not
#     a sign the bytes changed. It is therefore TOLERATED: the exit status is
#     the signal, and the warning is echoed as a note so a human reading the
#     log knows it was seen and dismissed on purpose. Failing on it would be
#     failing on upstream code we are forbidden to patch.
#
#   * vendor/lame.all.js is a browserified bundle of the lamejs src/js tree.
#     It parses cleanly on node v26 as a classic script today. If a future
#     bundle shape ever stops parsing (a top-level `return`, a `module.exports`
#     in script position, an ESM-only construct), that is a property of the
#     bundle, not of this build, so it is recorded as a note and NOT counted as
#     a failure - and crucially the file is NOT excused from the existence,
#     byte-audit, UTF-8 or SHA-256 gates, which is where real damage shows up.
for f in $VENDOR_ENCODERS; do
	[ -f "$f" ] || continue

	if node --check "$f" >/dev/null 2>"$errfile"; then
		if [ -s "$errfile" ]; then
			note "node --check $f exited 0 with stderr - expected for the asm.js bundle, tolerated:"
			sed 's/^/          /' "$errfile"
		fi
		pass "parses  $f"
	else
		note "node --check $f does not parse as a classic script (known non-module bundle) - not a build failure"
		note "integrity of this file is enforced by the SHA-256 gate above, not by the parser"
		sed 's/^/          /' "$errfile" | head -3
	fi
done

# --- 6. manifest.json integrity + referenced paths ------------------------
printf '\n-- manifest.json\n'
if [ -f manifest.json ]; then
	manifest_out=$(python3 - <<'PY' 2>&1
import json
import os
import sys

BINARY_OK = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico")

try:
    with open("manifest.json", encoding="utf-8") as fh:
        m = json.load(fh)
except UnicodeDecodeError as exc:
    print("  manifest.json is not valid UTF-8: %s" % exc)
    sys.exit(1)
except ValueError as exc:
    print("  manifest.json is not valid JSON: %s" % exc)
    sys.exit(1)

if m.get("manifest_version") != 3:
    print("  manifest_version is %r, expected 3" % m.get("manifest_version"))
    sys.exit(1)

refs = []


def add(label, path):
    if isinstance(path, str):
        refs.append((label, path))


add("background.service_worker", (m.get("background") or {}).get("service_worker"))
add("action.default_popup", (m.get("action") or {}).get("default_popup"))
add("side_panel.default_path", (m.get("side_panel") or {}).get("default_path"))
add("options_ui.page", (m.get("options_ui") or {}).get("page"))
for k, v in ((m.get("action") or {}).get("default_icon") or {}).items():
    add("action.default_icon.%s" % k, v)
for k, v in (m.get("icons") or {}).items():
    add("icons.%s" % k, v)
for i, cs in enumerate(m.get("content_scripts") or []):
    for j, p in enumerate(cs.get("js") or []):
        add("content_scripts[%d].js[%d]" % (i, j), p)
    for j, p in enumerate(cs.get("css") or []):
        add("content_scripts[%d].css[%d]" % (i, j), p)
for i, w in enumerate(m.get("web_accessible_resources") or []):
    for j, p in enumerate(w.get("resources") or []):
        add("web_accessible_resources[%d].resources[%d]" % (i, j), p)

# The worker loads the extracted `background/parts/*.js` sections through
# `importScripts`, which the manifest cannot express. Without this, a renamed or
# deleted part is invisible here and fails at runtime instead — as a route that
# throws the first time it is used, minutes into a session.
worker = (m.get("background") or {}).get("service_worker")
if isinstance(worker, str) and os.path.exists(worker):
    import re as _re
    wtext = open(worker, encoding="utf-8").read()

    # Quote/backslash characters come from chr() so this file's shell quoting is
    # not entangled with the python heredoc's: a stray apostrophe in prose here
    # silently changes how the heredoc is parsed and makes bash report a syntax
    # error hundreds of lines away from the real cause.
    CH, Q1, Q2, BS = chr(92), chr(39), chr(34), chr(92)

    def _strip_js_comments(src):
        """Blank out // and /* */ comments, preserving length and newlines.

        Necessary before any regex over this file: the importScripts call carries
        a block comment explaining the load-order rule, and inside prose an
        apostrophe looks exactly like a string delimiter to a regex. Scanning the
        raw text therefore reads English as a path.
        """
        out = list(src)
        i, n = 0, len(src)
        while i < n:
            c = src[i]
            if c == Q1 or c == Q2 or c == BS:
                i += 1
                while i < n and src[i] != c:
                    i += 2 if src[i] == BS else 1
                i += 1
                continue
            if src[i:i + 2] == "//":
                while i < n and src[i] != chr(10):
                    out[i] = " "
                    i += 1
                continue
            if src[i:i + 2] == "/*":
                end = src.find("*/", i + 2)
                end = n if end < 0 else end + 2
                for k in range(i, end):
                    if out[k] != chr(10):
                        out[k] = " "
                i = end
                continue
            i += 1
        return "".join(out)

    def _import_scripts_paths(src):
        """Yield every string argument of every `importScripts(...)` call."""
        clean = _strip_js_comments(src)
        for mm in _re.finditer(r"\bimportScripts\s*\(", clean):
            i, depth = mm.end(), 1
            while i < len(clean) and depth:
                c = clean[i]
                if c == Q1 or c == Q2:
                    q, i = c, i + 1
                    start = i
                    while i < len(clean) and clean[i] != q:
                        i += 2 if clean[i] == BS else 1
                    yield clean[start:i]
                    i += 1
                    continue
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                i += 1

    for lit in _import_scripts_paths(wtext):
        # importScripts paths are relative to the worker's own directory.
        resolved = os.path.normpath(os.path.join(os.path.dirname(worker), lit))
        refs.append(("background.service_worker importScripts", resolved))

missing = [(label, p) for label, p in refs if not os.path.exists(p)]

# HTML pages may pull in further local assets; check those too.
html_refs = []
for page in ("popup/popup.html", "side_panel.html", "options/options.html",
             "offscreen/offscreen.html"):
    if not os.path.exists(page):
        missing.append(("<html page>", page))
        continue
    import re
    try:
        text = open(page, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as exc:
        print("  cannot read %s: %s" % (page, exc))
        sys.exit(1)
    base = os.path.dirname(page)
    for ref in (re.findall(r'<script[^>]*\bsrc="([^"]+)"', text) +
                re.findall(r'<link[^>]*\bhref="([^"]+)"', text)):
        if ref.startswith(("http://", "https://", "data:", "#")):
            html_refs.append((page, ref, "EXTERNAL - must match CSP"))
            continue
        resolved = os.path.normpath(os.path.join(base, ref))
        if not os.path.exists(resolved):
            missing.append((page, ref))

print("  valid JSON, manifest_version 3, %d referenced path(s) checked" % len(refs))
for label, p in refs:
    if not os.path.exists(p):
        print("    FAIL %-44s %-26s MISSING" % (label, p))
        continue
    kind = "binary" if p.endswith(BINARY_OK) else "text "
    enc = ""
    if kind == "text ":
        try:
            with open(p, "rb") as fh:
                fh.read().decode("utf-8")
            enc = "utf-8 ok"
        except (OSError, UnicodeDecodeError):
            enc = "NOT UTF-8"
            missing.append((label, p))
    print("    ok   %-44s %-26s %s %s" % (label, p, kind, enc))
for page, ref, why in html_refs:
    print("    WARN %-44s %-26s %s" % (page, ref, why))

if missing:
    print("  %d missing/bad reference(s):" % len(missing))
    for label, p in missing:
        print("    - %s -> %s" % (label, p))
    sys.exit(1)
PY
)
	manifest_rc=$?
	printf '%s\n' "$manifest_out"
	if [ "$manifest_rc" -eq 0 ]; then
		pass "manifest valid; every referenced path exists"
	else
		fail "manifest problem (listed above)"
	fi
else
	fail "manifest.json not found"
fi

# --- summary --------------------------------------------------------------
if [ "$fails" -eq 0 ]; then
	printf '\n== PASS: %d checks, 0 failures\n' "$checks"
	printf '== The extension should load. If Chrome still refuses it, remove the\n'
	printf '== extension at chrome://extensions and re-add the folder.\n\n'
	exit 0
fi

printf '\n== FAIL: %d checks, %d failure(s)\n' "$checks" "$fails"
printf '== Do not ship this build.\n\n'
exit 1