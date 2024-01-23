# tz-repack

Complete IANA timezone database repackaged for easy offline use.

The entire database is packed into a single json file totalling ~660kb raw or ~50kb gzipped.

This repack includes everything from the original source files, nothing was removed or modified, and is currently available in two flavors, IANA and GTZ:

* IANA: the original source files maintained by [iana.org](https://iana.org/time-zones)
* GTZ: alternative source files maintained by [JodaOrg](https://github.com/JodaOrg/global-tz) that aim to restore historical timezones that were lost with the recent IANA changes

Additionally, a daily Github Actions workflow is active in this repo and will automatically repack the next tzdata versions whenever they becomes available.

## Format

The packed json file uses the following format:

```ts
{
    version: string,
    zones: Array<{
        name: string, // timezone identifier, ie: America/New_York
        abbrs: Array<string>, // list of abbreviations, ie: EST
        offsets: Array<number> // list of timezone offsets in minutes
        untils: Array<number | null> // list of time markers in hours: [initial_timestamp, ...time_diffs, null]
        data: string // binary data represented as a string of utf16 code points where each character stores 20 bits of information
    } | {
        name: string, // timezone identifier
        link: string // some timezones are aliases to other timezones, here is the name of the timezone we should redirect to
    }>
}
```

Unpacking the binary data requires iterating over the data characters and adding the cumulative time differences in order to obtain the actual timestamps.

Here's some pseudocode:

```js
// each character in the zone.data string represents an entry for a given timezone and contains information for that timezone during a specific period of time
// each character holds 20 bits of information as follows: [5 bits abbr_index][5 bits offset_index][1 bit dst][9 bits until_index]

abbr_index // first 5 bits, index to get the timezone abbreviation from the abbrs array
offset_index // next 5 bits, index to get the timezone offset from the offsets array
isDST // next 1 bit, whether or not daylight savings is active
until_index // final 9 bits, index to get the timestamp data from the untils array

// the untils array holds the necessary information to reconstruct the timeline of the timezone including the timestamps of each entry
if(untils[until_index] === null) { // if the until is null, we reached end of time
    timestamp = Infinity // extend to infinity
} else if(until_index === 0) { // if the entry is the first entry we use it directly
    timestamp = untils[until_index] * 3600000 // first until is the initial timestamp in hours, convert hours to milliseconds
} else { // all other untils represent the time offset in hours since the previous timestamp
    timestamp = get_previous_timestamp_somehow + untils[until_index] * 3600000 // convert hours to milliseconds and add to the previous timestamp
}

entry = { // example of a single timeline entry for a given timezone
    abbr: zone.abbrs[abbr_index], // current timezone abbreviation, if available
    offset: zone.offsets[offset_index], // current timezone offset in minutes
    isDTS: isDST, // whether or not daylight savings is currently active
    until: timestamp // timestamp until when the current entry is valid
}
```

## Build file

The `build.js` file contains the entire build process used to create the repacked timezone database files, including downloading, compiling and extracting the timezone data from the raw tzdata files.

## Unpacker file

A small utility class can be found in `unpacker.js`, it should support all platforms including browsers.

Feel free to use it directly, or as an example for how to unpack the packed json format.

```js
// example
const Unpacker = require("./unpacker.js");
const data = require("./2023d.json");

const timezone = new Unpacker(data);
console.log(timezone.getZone("america/new_york"));
```

```ts
// typings
class TimezoneUnpacker {
    constructor(data: packedJsonFile)
    getZone(timezone: string): unpackedTimezoneData
    getZoneEntry(timezone: string, timestamp: number): unpackedTimezoneEntry
    hasZone(timezone: string): boolean
    listZones(): string[]
    static unpackZone(packedTimezoneData): unpackedTimezoneData
    static unpackFile(packedJsonfile): unpackedJsonFile
}

type packedJsonFile = {
    version: string,
    zones: packedTimezoneData[]
}

type packedTimezoneData = {
    name: string,
    abbrs: string[],
    offsets: number[],
    untils: (number | null)[],
    data: string
}

type unpackedJsonFile = {
    version: string,
    zones: unpackedTimezoneData[],
    index: Record<string, unpackedTimezoneData>
}

type unpackedTimezoneData = {
    name: string,
    data: unpackedTimezoneEntry[]
}

type unpackedTimezoneEntry = {
    abbr: string,
    offset: number,
    dst: boolean,
    from: number,
    until: number
}
```
