# tz-repack

Complete IANA timezone database repackaged for easy offline use.

The entire database is packed into a single JSON file, about 280–320 KiB raw or 37–41 KiB gzipped per flavor.

This repack includes everything from the original source files, nothing was removed or modified, and is currently available in two flavors, IANA and GTZ:

* IANA: the original source files maintained by [iana.org](https://iana.org/time-zones)
* GTZ: alternative source files maintained by [JodaOrg](https://github.com/JodaOrg/global-tz) that aim to restore historical timezones that were lost with the recent IANA changes

Additionally, a daily Github Actions workflow is active in this repo and will automatically repack the next tzdata versions whenever they become available.

## Versioning

When either source releases a new version, this repository's `package.json` is updated and a Github release is published.

The versioning scheme losely follows IANA's versioning, with the year as the major version and the letter as a numeric minor version. The patch version denotes alternate source releases or lesser updates, followed by additional build metadata. For example:

`IANA 2027a` -> `2027.1.0+2027a-iana`
`GTZ 2027a` -> `2027.1.1+2027a-gtz`


## Build file

The `build.js` file contains the entire build process used to create the repacked timezone database files, including downloading, compiling and extracting the timezone data from the raw files.

This file is automatically executed once per day via Github Actions in order to check for updates.

The build file is designed for Linux only and requires `nodejs` (20.12+), `gcc`, `make`, `tar` and `gzip` to be installed in the system.

Windows is not supported.

## Unpacker file

A small utility class for JavaScript users can be found in `unpacker.js`, it should support all platforms including browsers.

Feel free to use it directly, or as a working example for how to unpack the packed json format.

```js
// example
const Unpacker = require("./unpacker.js");
const data = require("./build/IANA/latest.json");

const timezone = new Unpacker(data);
console.log(timezone.getZone("america/new_york"));
```

## Format

The packed JSON file has the following format:

```ts
{
    version: string, // upstream tzdata release, e.g. 2026e
    zones: Array<{
        name: string, // timezone identifier, e.g. America/New_York
        states: Array<[abbr: string, offset: number, dst: 0 | 1]>, // offset in minutes west of UTC
        untils: Array<number | null>, // initial timestamp or delta in hours; null means no end
        data: string // one Unicode code point per interval
    } | {
        name: string, // alias identifier
        link: string // canonical timezone identifier
    }>
}
```

Each code point in `data` stores a 16-bit word: `[7 bits state index][9 bits until index]`. Both dictionaries are sorted by descending frequency, with ties in first-use order. The encoding skips unsafe characters by offsetting them, which decoding needs to reverse.

Unpacking the timeline means taking the first boundary as an absolute Unix timestamp and adding each later delta to the previous boundary. It's the position in `data`, not the index in `untils`, that identifies the first interval.

Here's the decoding loop. See `unpacker.js` for the full implementation.

```js
const entries = [];
let from = -Infinity;

for (const char of zone.data) {
    let word = char.codePointAt(0);
    // reverse offsets added by encoder
    if (word >= 0xe000) word -= 0x800; // surrogates
    if (word > 0x5c) word--; // backslash
    if (word > 0x22) word--; // quotation
    word -= 0x20; // control characters

    // get current until and state
    const stateIndex = word >> 9;
    const untilIndex = word & 511;
    const [abbr, offset, dst] = zone.states[stateIndex];
    const hours = zone.untils[untilIndex];

    // get full until timestamp from initial value or by adding delta to the previous value
    const until = hours === null ? Infinity : (entries.length ? from : 0) + hours * 3600000;

    entries.push({ abbr, offset, dst: Boolean(dst), from, until });
    from = until;
}
```
