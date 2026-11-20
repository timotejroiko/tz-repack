class TimezoneUnpacker {
    /**
     * @param {{
     *      version: string,
     *      zones: ({
     *          name: string,
     *          states: [abbr: string, offset: number, dst: 0 | 1][],
     *          untils: (number | null)[],
     *          data: string
     *      } | {
     *          name: string,
     *          link: string
     *      })[]
     * }} data the packed json file
     */
    constructor(data) {
        this.version = data.version;
        this._data = data.zones;
        this._index = {};
        for(const zone of this._data) {
            this._index[zone.name.toLowerCase()] = zone;
        }
    }

    /**
     * @param {string} zone timezone string, case insensitive
     * @returns {{
     *      name: string,
     *      data: {
     *          abbr: string,
     *          offset: number,
     *          dst: boolean,
     *          from: number,
     *          until: number
     *      }[]
     * }} returns the unpacked timezone data
     */
    getZone(zone) {
        const z = this._index[zone?.toLowerCase()];
        if(z) {
            if(z.link) {
                const l = this._index[z.link.toLowerCase()];
                if(!l.unpacked) {
                    l.unpacked = TimezoneUnpacker.unpackZone(l).data;
                }
                return {
                    name: z.name,
                    data: l.unpacked
                }
            } else {
                if(!z.unpacked) {
                    z.unpacked = TimezoneUnpacker.unpackZone(z).data;
                }
                return {
                    name: z.name,
                    data: z.unpacked
                }
            }
        }
    }

    /**
     * @param {string} zone timezone string, case insensitive
     * @param {number} [timestamp] timestamp to get the corresponding zone entry, defaults to now
     */
    getZoneEntry(zone, timestamp = Date.now()) {
        const z = this.getZone(zone);
        if(z) {
            const index = z.data.findIndex(x => timestamp < x.until);
            return z.data[index];
        }
    }

    /**
     * @param {string} zone the timezone string, case insensitive
     * @returns {boolean} whether or not the timezone exists in the file
     */
    hasZone(zone) {
        return zone?.toLowerCase() in this._index;
    }

    /**
     * @returns {string[]} returns all available timezones
     */
    listZones() {
        return this._data.map(x => x.name);
    }

    /**
     * @param {{
     *      name: string,
     *      states: [abbr: string, offset: number, dst: 0 | 1][],
     *      untils: (number | null)[],
     *      data: string
     *  }} zone the packed zone data object
     * @returns the unpacked zone data
     */
    static unpackZone(zone) {
        const unpacked = [];
        for(const char of zone.data) {
            let code = char.codePointAt(0);
            // Reverse the code point mapping in build.js.
            if(code >= 0xe000) { code -= 0x800; }
            if(code > 0x5c) { code--; }
            if(code > 0x22) { code--; }
            code -= 0x20;
            const prev = unpacked[unpacked.length - 1];
            const [abbr, offset, isdst] = zone.states[code >>> 9];
            const until = zone.untils[code & 511];
            const realuntil = until === null ? Infinity : until * 3600000;
            unpacked.push({
                abbr,
                offset,
                from: prev ? prev.until : -Infinity,
                until: prev ? prev.until + realuntil : realuntil,
                dst: Boolean(isdst)
            });
        }
        return {
            name: zone.name,
            data: unpacked
        };
    }

    /**
     * @param {ConstructorParameters<typeof TimezoneUnpacker>[0]} data the packed json file
     * @returns a fully unpacked object including index and link references. index is lowercased
     */
    static unpackFile(data) {
        const unpacked = {
            version: data.version,
            zones: [],
            index: {}
        }
        for(const zone of data.zones) {
            if(!zone.link) {
                const obj = TimezoneUnpacker.unpackZone(zone);
                unpacked.zones.push(obj);
                unpacked.index[obj.name.toLowerCase()] = obj;
            }
        }
        for(const zone of data.zones) {
            if(zone.link) {
                const obj = {
                    name: zone.name,
                    data: unpacked.index[zone.link.toLowerCase()].data
                };
                unpacked.zones.push(obj);
                unpacked.index[obj.name.toLowerCase()] = obj;
            }
        }
        return unpacked;
    }
}

if(typeof module !== "undefined" && module && module.exports && typeof module.exports === "object") {
    module.exports = TimezoneUnpacker;
}
