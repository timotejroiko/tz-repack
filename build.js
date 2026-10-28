const fs = require("node:fs/promises");
const cp = require("node:child_process");
const stream = require("node:stream");
const path = require("node:path");
const { promisify } = require("node:util");

const execFile = promisify(cp.execFile);
const workdir = "./temp";
const builddir = "./build";
const sources = ["IANA", "GTZ"];
const toolOptions = { maxBuffer: 20 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };

async function main() {
    try {
        await mkdir(sources);
        const target = process.argv[2];
        let tools;
        const latest = {};
        const changed = [];
        for(const type of sources) {
            const current = target ? null : await getLocal(type);
            const version = target ? getTarget(target, type) : await getRemote(type);
            latest[type] = version;
            validateVersion(version, type);
            if(version === current) {
                console.log(`Current ${type} version is up to date: ${current}`);
                continue;
            }
            tools ||= await prepareTools();
            console.log(`Building ${type} ${version}`);
            await download(version, type);
            await compile(version, type, tools);
            if(!target) {
                await fs.copyFile(`${builddir}/${type}/${version}.json`, `${builddir}/${type}/latest.json`);
                changed.push(type);
            }
        }
        if(!target) { await updatePackageVersion(latest, changed); }
    } finally {
        await fs.rm(workdir, { recursive: true, force: true });
    }
}

async function getLocal(type) {
    const latest = await fs.readFile(`${builddir}/${type}/latest.json`, { encoding: "utf8" }).catch(() => null);
    return JSON.parse(latest)?.version || "none";
}

function nextVersion(current, iana, gtz, sources) {
    if(!sources.length) { return current; }
    const releases = [iana, gtz].map(version => {
        const match = /^(\d{4})([a-z])(?:gtz)?$/.exec(version);
        if(!match) { throw new Error(`Unsupported timezone release: ${version}`); }
        return [Number(match[1]), match[2].charCodeAt(0) - 96];
    });
    const [year, minor] = releases.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
    const previous = /^(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9.-]+)?$/.exec(current);
    if(!previous) { throw new Error(`Unsupported package version: ${current}`); }
    const [, previousYear, previousMinor, previousPatch] = previous.map(Number);
    const patch = year === previousYear && minor === previousMinor ? previousPatch + 1 : 0;
    return `${year}.${minor}.${patch}+${year}${String.fromCharCode(96 + minor)}-${sources.join(".").toLowerCase()}`;
}

async function updatePackageVersion(latest, changed) {
    if(!changed.length) { return; }
    const packageJson = await fs.readFile("package.json", "utf8");
    const version = nextVersion(JSON.parse(packageJson).version, latest.IANA, latest.GTZ, changed);
    await fs.writeFile("package.json", packageJson.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${version}$2`));
    console.log(`Prepared ${version}: IANA ${latest.IANA}, GTZ ${latest.GTZ}`);
}

async function getRemote(type) {
    const url = type === "IANA" ? "https://data.iana.org/time-zones/tzdb/version" :
        "https://api.github.com/repos/JodaOrg/global-tz/releases/latest";
    const response = await request(url);
    return type === "IANA" ? (await response.text()).trim() : (await response.json()).tag_name;
}

function validateVersion(version, type) {
    if(!sources.includes(type) || typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
        throw new Error(`Invalid ${type} version: ${version}`);
    }
}

function getUrl(version, type) {
    validateVersion(version, type);
    return type === "IANA" ?
        `https://data.iana.org/time-zones/releases/tzdata${version}.tar.gz` :
        `https://github.com/JodaOrg/global-tz/releases/download/${version}/tzdata${version}.tar.gz`;
}

function getTarget(target, type) {
    if(!/^\d{4}[a-z](?:gtz)?$/.test(target)) { throw new Error(`Invalid release: ${target}`); }
    return target.slice(0, 5) + (type === "GTZ" ? "gtz" : "");
}

async function mkdir(types) {
    await fs.mkdir(workdir, { recursive: true });
    await Promise.all(types.map(type => fs.mkdir(`${builddir}/${type}`, { recursive: true })));
}

async function request(url) {
    const headers = url.startsWith("https://api.github.com/") && process.env.GH_TOKEN ?
        { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
    const response = await fetch(url, { headers });
    if(!response.ok) { throw new Error(`Fetching ${url}: ${response.status} ${response.statusText}`); }
    return response;
}

async function extract(url, directory) {
    const archive = path.join(directory, path.basename(new URL(url).pathname));
    console.log(`Fetching ${url}`);
    const response = await request(url);
    if(!response.body) { throw new Error(`Empty archive response: ${url}`); }
    const body = /** @type {import("stream/web").ReadableStream} */ (response.body);
    await fs.writeFile(archive, stream.Readable.fromWeb(body));
    await execFile("tar", ["-xzf", archive, "-C", directory], toolOptions);
}

async function prepareTools(version) {
    version ||= await getRemote("IANA");
    validateVersion(version, "IANA");
    const directory = path.resolve(workdir, "tools");
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    await extract(`https://data.iana.org/time-zones/releases/tzcode${version}.tar.gz`, directory);
    // The Makefile's version target also depends on timezone data files.
    await extract(`https://data.iana.org/time-zones/releases/tzdata${version}.tar.gz`, directory);
    // Build the extraction tools once per run.
    await execFile("make", ["zic", "zdump"], { ...toolOptions, cwd: directory });
    return { zic: path.join(directory, "zic"), zdump: path.join(directory, "zdump") };
}

async function download(version, type, url = getUrl(version, type)) {
    validateVersion(version, type);
    const directory = path.resolve(workdir, type);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    await extract(url, directory);
}

async function compile(version, type, tools) {
    validateVersion(version, type);
    const p = path.resolve(workdir, type);
    const options = { ...toolOptions, cwd: p };
    const files = ["africa", "antarctica", "asia", "australasia", "europe", "northamerica", "southamerica", "etcetera", "backward"];
    const texts = await Promise.all(files.map(file => fs.readFile(path.join(p, file), "utf8")));
    const text = texts.join("\n");
    await fs.writeFile(path.join(p, "selected.zi"), text);
    const compiled = path.join(p, "compiled");
    await fs.mkdir(compiled);
    await execFile(tools.zic, ["-d", compiled, "selected.zi"], options);
    const zones = new Set();
    const links = new Map();
    for(const line of text.split(/\r?\n/)) {
        const fields = line.split("#", 1)[0].trim().split(/\s+/);
        if(fields[0] === "Zone") {
            validateName(fields[1]);
            zones.add(fields[1]);
        } else if(fields[0] === "Link") {
            validateName(fields[1]);
            validateName(fields[2]);
            links.set(fields[2], fields[1]);
        }
    }
    if(!zones.size) { throw new Error("No source zones found"); }
    const final = [];
    for(const [name, target] of links) {
        let resolved = target;
        const visited = new Set([name]);
        while(links.has(resolved)) {
            if(visited.has(resolved)) { throw new Error(`Cyclic link: ${name}`); }
            visited.add(resolved);
            resolved = links.get(resolved);
        }
        if(!zones.has(resolved)) { throw new Error(`Missing link target: ${name} -> ${resolved}`); }
        final.push({ name, link: resolved });
    }
    const zoneNames = [...zones];
    for(let i = 0; i < zoneNames.length; i += 10) {
        const batch = await Promise.all(zoneNames.slice(i, i + 10).map(async name => {
            const file = path.join(compiled, ...name.split("/"));
            const { stdout } = await execFile(tools.zdump, ["-V", "-c", "-500,2500", file], options);
            let timeline;
            if(stdout.trim()) {
                timeline = parseTransitions(stdout, file);
            } else {
                const initial = await execFile(tools.zdump, ["-i", "-c", "-500,2500", file], options);
                timeline = parseFixed(initial.stdout);
            }
            return packZone(name, timeline);
        }));
        final.push(...batch);
        console.log(`${Math.min(i + 10, zoneNames.length)}/${zoneNames.length} zones collected`);
    }
    final.sort((a, b) => a.name.localeCompare(b.name));
    const file = `${builddir}/${type}/${version}.json`;
    const json = JSON.stringify({ version, zones: final });
    const previous = await fs.readFile(file, "utf8").catch(error => {
        if(error.code !== "ENOENT") { throw error; }
        return null;
    });
    await fs.writeFile(file, json);
    console.log(`Finished ${type} ${version}`);
    return json !== previous;
}

function validateName(name) {
    if(typeof name !== "string" || !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(name) ||
        name.split("/").some(part => part === "." || part === "..")) {
        throw new Error(`Invalid zone name: ${name}`);
    }
}

function validateState(state) {
    if(!Number.isFinite(state.offset) || Math.abs(state.offset) > 1440 ||
        typeof state.abbr !== "string" || !state.abbr.length || /[\x00-\x20\x7f]/.test(state.abbr) ||
        (state.dst !== 0 && state.dst !== 1)) {
        throw new Error(`Invalid zone state: ${JSON.stringify(state)}`);
    }
    return state;
}

function parseTransitions(output, file) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const records = output.trimEnd().split(/\r?\n/).map(line => {
        if(!line.startsWith(file + "  ")) { throw new Error(`Malformed zdump record: ${line}`); }
        const match = /^\s*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\w{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (-?\d+) UT = .+? (\S+) isdst=(-?\d+) gmtoff=(-?\d+)$/.exec(line.slice(file.length));
        if(!match) { throw new Error(`Malformed zdump record: ${line}`); }
        const [, month, day, hour, minute, second, year, abbr, dst, gmtoff] = match;
        const date = new Date(0);
        date.setUTCFullYear(Number(year), months.indexOf(month), Number(day));
        date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
        if(months.indexOf(month) < 0 || !Number.isFinite(date.getTime())) {
            throw new Error(`Invalid UTC timestamp: ${line}`);
        }
        return { at: date.getTime(), ...validateState({ abbr, dst: Number(dst), offset: -Number(gmtoff) / 60 }) };
    });
    if(!records.length || records.length % 2) { throw new Error(`Incomplete transitions: ${file}`); }
    const timeline = [];
    let current = records[0];
    for(let i = 0; i < records.length; i += 2) {
        const before = records[i];
        const after = records[i + 1];
        if(after.at !== before.at + 1000 || (i && before.at <= records[i - 1].at) ||
            !sameState(before, current)) { throw new Error(`Inconsistent transitions: ${file}`); }
        if(!sameState(before, after)) {
            timeline.push({ ...current, until: after.at });
            current = after;
        }
    }
    timeline.push({ ...current, until: Infinity });
    return timeline;
}

function sameState(a, b) {
    return a.abbr === b.abbr && a.offset === b.offset && a.dst === b.dst;
}

function parseFixed(output) {
    const lines = output.trim().split(/\r?\n/);
    if(lines.length !== 2 || !/^TZ=".*"$/.test(lines[0])) { throw new Error(`Malformed fixed-zone dump: ${output}`); }
    const fields = lines[1].split("\t");
    const match = /^([+-])(\d{2})(?:(\d{2})(\d{2})?)?$/.exec(fields[2]);
    if(fields[0] !== "-" || fields[1] !== "-" || !match || fields.length > 5 ||
        (fields[4] !== undefined && !/^[01]$/.test(fields[4])) ||
        Number(match[3] || 0) > 59 || Number(match[4] || 0) > 59) {
        throw new Error(`Malformed fixed-zone interval: ${lines[1]}`);
    }
    const [, sign, hours, minutes = "0", seconds = "0"] = match;
    let abbr = fields[3] || fields[2];
    if(abbr.startsWith('"')) {
        if(!/^"(?:[^"\\]|\\[s"\\fnrtv])*"$/.test(abbr)) { throw new Error(`Invalid abbreviation: ${abbr}`); }
        const escapes = { s: " ", '"': '"', "\\": "\\", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
        abbr = abbr.slice(1, -1).replace(/\\([s"\\fnrtv])/g, (_, char) => escapes[char]);
    } else if(fields[3] && !/^[A-Za-z]+$/.test(abbr)) {
        throw new Error(`Invalid abbreviation: ${abbr}`);
    }
    const offset = (Number(hours) * 60 + Number(minutes) + Number(seconds) / 60) * (sign === "+" ? -1 : 1);
    const dst = fields[4] === undefined ? 0 : Number(fields[4]);
    return [{ ...validateState({ abbr, offset, dst }), until: Infinity }];
}

function packZone(name, timeline) {
    if(!timeline.length || timeline[timeline.length - 1].until !== Infinity) { throw new Error(`Empty or unterminated timeline: ${name}`); }
    const abbrs = [];
    const offsets = [];
    const untils = [];
    const chars = [];
    let previous = -Infinity;
    for(let i = 0; i < timeline.length; i++) {
        const state = validateState(timeline[i]);
        if(!(state.until > previous) || (state.until !== Infinity && !Number.isSafeInteger(state.until))) {
            throw new Error(`Invalid transition boundary: ${name}`);
        }
        const until = (i ? state.until - previous : state.until) / 3600000;
        if(!abbrs.includes(state.abbr)) { abbrs.push(state.abbr); }
        if(!offsets.includes(state.offset)) { offsets.push(state.offset); }
        if(!untils.includes(until)) { untils.push(until); }
        const code = abbrs.indexOf(state.abbr) * 32768 + offsets.indexOf(state.offset) * 1024 +
            state.dst * 512 + untils.indexOf(until);
        if(offsets.length > 32 || untils.length > 512 || code > 0x10ffff) {
            throw new Error(`Packed dictionary overflow: ${name}`);
        }
        chars.push(String.fromCodePoint(code));
        previous = state.until;
    }
    return { name, abbrs, offsets, untils, data: chars.join("") };
}

module.exports = {
    mkdir, getRemote, getUrl, getTarget, validateVersion, request, prepareTools, download, compile,
    parseTransitions, parseFixed, packZone, sameState, nextVersion, updatePackageVersion
};

if(require.main === module) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
