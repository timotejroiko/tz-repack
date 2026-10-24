const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const TimezoneUnpacker = require('./unpacker');

const zeroNames = new Set([
    'Etc/UTC', 'UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal',
    'Etc/Zulu', 'Zulu', 'Etc/GMT', 'GMT', 'Etc/GMT0', 'GMT0',
    'Etc/GMT+0', 'GMT+0', 'Etc/GMT-0', 'GMT-0', 'Etc/Greenwich', 'Greenwich'
]);

for (const family of ['IANA', 'GTZ']) {
    const directory = path.join(__dirname, 'build', family);
    const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort();

    test(`${family}: latest matches its versioned file`, () => {
        assert.ok(files.includes('latest.json'));
        const latest = readFileSync(path.join(directory, 'latest.json'));
        const { version } = JSON.parse(latest.toString('utf8'));
        assert.equal(typeof version, 'string');
        assert.notEqual(version, 'latest');
        assert.ok(files.includes(`${version}.json`), `missing versioned file: ${version}`);
        assert.deepEqual(latest, readFileSync(path.join(directory, `${version}.json`)));
    });

    for (const file of files) {
        test(`${family}/${file}: decoded timezone integrity`, () => {
            const packed = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
            assert.equal(typeof packed.version, 'string');
            assert.ok(packed.version.length > 0);
            if (file !== 'latest.json') assert.equal(packed.version, path.basename(file, '.json'));
            assert.ok(Array.isArray(packed.zones) && packed.zones.length > 0);
            const byName = new Map();
            const foldedNames = new Set();
            for (const zone of packed.zones) {
                assert.equal(typeof zone.name, 'string');
                assert.match(zone.name, /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/);
                assert.ok(!zone.name.includes('undefined'), `invalid timezone name: ${zone.name}`);
                assert.ok(!foldedNames.has(zone.name.toLowerCase()), `duplicate timezone: ${zone.name}`);
                foldedNames.add(zone.name.toLowerCase());
                byName.set(zone.name, zone);
            }
            const unpacker = new TimezoneUnpacker(packed);
            for (const zone of packed.zones) {
                const name = zone.name;
                if (Object.hasOwn(zone, 'link')) {
                    assert.equal(typeof zone.link, 'string', `${name}: alias target`);
                    const target = byName.get(zone.link);
                    assert.ok(target && target !== zone && !Object.hasOwn(target, 'link'), `${name}: canonical target`);
                    assert.deepEqual(unpacker.getZone(name).data, unpacker.getZone(zone.link).data, `${name}: alias timeline`);
                }
                const entries = unpacker.getZone(name).data;
                assert.ok(entries.length > 0, `${name}: timeline`);
                const fixed = /^Etc\/GMT([+-])(\d+)$/.exec(name);
                const expectedOffset = zeroNames.has(name) ? 0 : fixed ? (fixed[1] === '+' ? 1 : -1) * Number(fixed[2]) * 60 : undefined;
                let from = -Infinity;
                for (const entry of entries) {
                    assert.equal(entry.from, from, `${name}: contiguous timeline`);
                    assert.ok(entry.until > entry.from, `${name}: increasing transition`);
                    assert.equal(typeof entry.abbr, 'string', `${name}: abbreviation`);
                    assert.match(entry.abbr, /^[\x21-\x7e]+$/, `${name}: printable abbreviation`);
                    assert.ok(Number.isFinite(entry.offset) && Math.abs(entry.offset) <= 24 * 60, `${name}: finite offset in minutes west`);
                    if (expectedOffset !== undefined) assert.equal(entry.offset, expectedOffset, `${name}: fixed offset sign`);
                    from = entry.until;
                }
                assert.equal(from, Infinity, `${name}: unbounded final entry`);
            }
        });
    }
}
