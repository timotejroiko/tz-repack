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

Here's a functional JavaScript example to unpack all the data in the json file:

```js
const json = ...; // load json file

for(const zone of json.zones) {
    if(zone.link) {
        continue; // ignore aliases
    }
    zone.unpacked = []; // create an array to hold unpacked entries

    // iterate over each character in the data array
    for(const char of zone.data) { // in js, for..of iterates over utf16 code points including surrogate pairs, so we can safely use it here
        const code = char.codePointAt(); // get character code point number
        const prev = zone.unpacked[zone.unpacked.length - 1]; // get previous entry if exists

        const abbr_index = code >> 15; // extract abbr index from number
        const offset_index = (code >> 10) & 31; // extract offset index from number
        const isdst = (code >> 9) & 1; // extract dst info from number
        const until_index = code & 511; // extract until index from number

        const abbr = zone.abbrs[abbr_index]; // get current abbr
        const offset = zone.offsets[offset_index]; // get current offset
        const until = zone.untils[until_index]; // get current until value
        const realuntil = until === null ? Infinity : until * 3600000 // null means we reached the end of time, so we extend to infinity, otherwise we convert hours to milliseconds

        zone.unpacked.push({
            abbr,
            offset,
            until: prev ? prev.until + realuntil : realuntil, // first until is the starting timestamp, other untils are the cumulative timestamp diffs that need to be added together
            dst: Boolean(isdst)
        });
    }
}
```
