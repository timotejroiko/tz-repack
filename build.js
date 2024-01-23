const fs = require("node:fs/promises");
const cp = require("node:child_process");
const stream = require("node:stream");
const path = require("node:path");

const workdir = "./temp";
const builddir = "./build";
const sources = ["IANA", "GTZ"];

(async () => {
    try {
        await mkdir(sources);
        if(process.argv[2]) {
            for(const type of sources) {
                const target = getTarget(process.argv[2], type);
                console.log(`Building ${type} ${target}`);
                await download(target, type);
                await compile(target, type);
            }
            console.log(("Done"));
        } else {
            let done = false;
            for(const type of sources) {
                console.log(`Checking for ${type} updates...`);
                const current = await getLocal(type);
                const latest = await getRemote(type);
                if(latest !== current) {
                    console.log(`Update found: ${type} ${current} -> ${type} ${latest}`);
                    console.log(("Begin download"));
                    await download(latest, type);
                    console.log(("Begin compilation"));
                    await compile(latest, type);
                    await fs.copyFile(`${builddir}/${type}/${latest}.json`, `${builddir}/${type}/latest.json`);
                    console.log((`${type} ${current} is ready`));
                    done = true;
                } else {
                    console.log(`Current ${type} version is up to date: ${current}`);
                }
            }
            if(done) {
                console.log(("Done"));
            }
        }
    } finally {
        await fs.rm(workdir, { recursive: true });
    }
})();

async function getLocal(type) {
    const latest = await fs.readFile(`${builddir}/${type}/latest.json`, { encoding: "utf8" }).catch(() => null);
    return JSON.parse(latest)?.version || "none";
}

async function getRemote(type) {
    switch(type) {
        case "IANA": {
            return await fetch("https://data.iana.org/time-zones/tzdb/version").then(x => x.text()).then(x => x.trim());
        }
        case "GTZ": {
            return await fetch("https://api.github.com/repos/JodaOrg/global-tz/releases/latest").then(x => x.json()).then(x => x.tag_name);
        }
        default: throw new Error("invalid type");
    }
}

function getUrl(version, type) {
    switch(type) {
        case "IANA": return `https://data.iana.org/time-zones/releases/tzdb-${version}.tar.lz`;
        case "GTZ": return `https://github.com/JodaOrg/global-tz/releases/download/${version}/tzdb-${version}.tar.lz`;
        default: throw new Error("invalid type");
    }
}

function getTarget(target, type) {
    switch(type) {
        case "IANA": return target.slice(0, 5);
        case "GTZ": return target.slice(0, 5) + "gtz";
    }
}

async function mkdir(types) {
    await fs.mkdir(builddir, { recursive: true }).catch(() => {});
    await fs.mkdir(workdir, { recursive: true }).catch(() => {});
    await Promise.all([
        ...types.map(x => fs.mkdir(`${builddir}/${x}`, { recursive: true }).catch(() => {})),
        ...types.map(x => fs.mkdir(`${workdir}/${x}`, { recursive: true }).catch(() => {}))
    ]);
}

/**
 * @param {string} version 
 */
async function download(version, type = "IANA") {
    const p = path.resolve(workdir, type);
    const url = getUrl(version, type);
    console.log(`Fetching ${url}`);
    const response = await fetch(url);
    if(response.status !== 200 || !response.body) {
        throw new Error(response.statusText);
    }
    const body = /** @type {import("stream/web").ReadableStream} */ (response.body);
    const readable = stream.Readable.fromWeb(body);
    console.log("Downloading file");
    await fs.writeFile(`${p}/tzdb-${version}.tar.lz`, readable);
    console.log("Extracting data");
    await new Promise((resolve, reject) => {
        cp.exec(`lzip -dc ${p}/tzdb-${version}.tar.lz | tar -xf - -C ${p} --strip-components=1`, err => err ? reject(err) : resolve(undefined));
    });
    console.log("Finished");
}

/**
 * @param {string} version 
 */
async function compile(version, type) {
    console.log("Compiling binaries");
    const p = path.resolve(workdir, type);
    await new Promise((resolve, reject) => {
        cp.exec("make", { cwd: p }, err => err ? reject(err) : resolve(undefined));
    });
    console.log("Compiling timezone files");
    const files = ["africa", "antarctica", "asia", "australasia", "europe", "northamerica", "southamerica", "etcetera", "backward"];
    await fs.mkdir(`${p}/compiled`).catch(() => {});
    for(const file of files) {
        // cannot be concurrent, race condition when generating files
        await new Promise((resolve, reject) => cp.exec(`zic -d ./compiled ./${file}`, { cwd: p }, err => err ? reject(err) : resolve(undefined)));
    }
    console.log("Collecting data...");
    const paths = await fs.readdir(`${p}/compiled`, { recursive: true, withFileTypes: true }).then(x => x.filter(x => x.isFile()).map(x => path.resolve(`${x.path}/${x.name}`)));
    const links = await Promise.all(files.map(
        file => fs.readFile(`${p}/${file}`, { encoding: "utf8" }).then(
            data => data.split("\n").filter(x => x.startsWith("Link\t")).map(x => x.split(/\s+/).slice(1, 3))
        )
    )).then(data => data.flat().reduce((a, t) => (a[t[1]] = t[0]) && a, {}));
    const concurrency = [];
    const final = [];
    let n = 1;
    for(const file of paths) {
        const name = file.slice(file.indexOf("compiled/") + 9);
        const link = links[name];
        if(link) {
            console.log(`${`${n++}/${paths.length}`.padEnd(10, " ")}${name} (link to ${link})`);
            final.push({ name, link });
            continue;
        }
        const promise = new Promise((resolve, reject) => {
            cp.exec(`zdump -V ${file}`, { cwd: p, maxBuffer: 20*1024*1024 }, (err, out) => {
                if(err) {
                    reject(err);
                } else if(!out.length) {
                    cp.exec(`zdump UTC ${file}`, { cwd: p }, (err, out2) => err ? reject(err) : resolve(out2));
                } else {
                    resolve(out);
                }
            });
        }).then(data => {
            console.log(`${`${n++}/${paths.length}`.padEnd(10, " ")}${name}`);
            const lines = data.split("\n").map(x => x.slice(x.indexOf("  ") + 2));
            const offsets = [];
            const untils = [];
            const abbrs = [];
            const isdst = [];
            for(const line of lines) {
                const parts = line.split(/\s+/);
                if(/failed|-2147481748|2147485547/.test(line) || parts.length < 12) {
                    break;
                }
                const utc = new Date(parts.slice(1, 5).join(" "));
                const local = new Date(parts.slice(8, 12).join(" "));
                offsets.push((utc.getTime() - local.getTime()) / 60000);
                untils.push(utc.getTime());
                abbrs.push(parts[12]);
                isdst.push(Number(parts[13].slice(6)));

            }
            if(offsets.length === 0 && lines.length === 3 && lines[2].length === 0) {
                const utcParts = lines[0].split(/\s+/);
                const localParts = lines[1].split(/\s+/);
                const utc = new Date(utcParts.slice(1, 5).join(" "));
                const local = new Date(localParts.slice(1, 5).join(" "));
                offsets.push((utc.getTime() - local.getTime()) / 60000);
                untils.push(Infinity);
                abbrs.push(localParts[5]);
                isdst.push(0);
            }
            const abbrs2   = [];
            const untils2  = [];
            const offsets2 = [];
            const isdst2 = [];
            for(let i = abbrs.length - 1; i >= 0; i--) {
                if (abbrs2[0] === abbrs[i] && offsets2[0] === offsets[i]) { continue; }
                untils2.unshift(i === abbrs.length - 1 ? Infinity : untils[i + 1]);
                abbrs2.unshift(abbrs[i]);
                offsets2.unshift(offsets[i]);
                isdst2.unshift(isdst[i]);
            }
            const abbrlist = [...new Set(abbrs2)];
            const offsetlist = [...new Set(offsets2)];
            const untillist = [...new Set(untils2.map((x, i) => (i > 0 ? Math.abs(x - untils2[i-1]) : x) / 3600000))];
            final.push({
                name,
                abbrs: abbrlist,
                offsets: offsetlist,
                untils: untillist,
                data: untils2.map((x, i) => String.fromCodePoint(
                    (abbrlist.indexOf(abbrs2[i]) << 15) +
                    (offsetlist.indexOf(offsets2[i]) << 10) +
                    (isdst2[i] << 9) +
                    untillist.indexOf((i > 0 ? Math.abs(x - untils2[i-1]) : x) / 3600000)
                )).join("")
            });
            concurrency.splice(concurrency.indexOf(promise), 1);
        });
        concurrency.push(promise);
        if(concurrency.length >= 10) {
            await Promise.race(concurrency);
        }
    }
    await Promise.all(concurrency);
    final.sort((a, b) => a.name.localeCompare(b.name));
    await fs.writeFile(`${builddir}/${type}/${version}.json`, JSON.stringify({
        version,
        zones: final
    }));
    console.log("Finished");
}
