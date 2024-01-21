const fs = require("node:fs/promises");
const cp = require("node:child_process");
const stream = require("node:stream");
const path = require("node:path");

const workdir = "./temp";
const builddir = "./build";

(async () => {
    try {
        await fs.mkdir(builddir, { recursive: true }).catch(() => {});
        await fs.mkdir(workdir, { recursive: true }).catch(() => {});
        if(process.argv[2]) {
            await manual();
        } else {
            await update();
        }
    } finally {
        await fs.rm(workdir, { recursive: true });
    }
})();

async function manual() {
    const target = process.argv[2];
    console.log(`Building ${target}`);
    console.log(("Begin download"));
    await download(target);
    console.log(("Begin compilation"));
    await compile(target);
    console.log(("Done"));
}

async function update() {
    console.log("Checking for updates...");
    const current = await getLocal();
    const latest = await getRemote();
    if(latest !== current) {
        console.log(`Update found: ${current} -> ${latest}`);
        console.log(("Begin download"));
        await download(latest);
        console.log(("Begin compilation"));
        await compile(latest);
        console.log(("Done"));
    } else {
        console.log(`Current version is up to date: ${current}`);
    }
}

async function getLocal() {
    const latest = await fs.readFile(`${builddir}/latest.json`, { encoding: "utf8" }).catch(() => null);
    const json = JSON.parse(latest);
    return json?.version;
}

async function getRemote() {
    const data = await fetch("https://api.github.com/repos/JodaOrg/global-tz/releases/latest").then(x => x.json());
    return data.tag_name;
}

/**
 * @param {string} version 
 */
async function download(version) {
    console.log(`Fetching...`);
    const response = await fetch(`https://github.com/JodaOrg/global-tz/releases/download/${version}/tzdb-${version}.tar.lz`);
    if(response.status !== 200 || !response.body) {
        throw new Error(response.statusText);
    }
    const body = /** @type {import("stream/web").ReadableStream} */ (response.body);
    const readable = stream.Readable.fromWeb(body);
    console.log(`Transferring...`);
    await fs.writeFile(`${workdir}/tzdb-${version}.tar.lz`, readable);
    console.log(`Extracting...`);
    await new Promise((resolve, reject) => {
        cp.exec(`lzip -dc ${workdir}/tzdb-${version}.tar.lz | tar -xf - -C ${workdir} --strip-components=1`, err => err ? reject(err) : resolve(undefined));
    });
    console.log("Finished");
}

/**
 * @param {string} version 
 */
async function compile(version) {
    console.log(`Compiling binaries...`);
    const p = path.resolve(workdir);
    await new Promise((resolve, reject) => {
        cp.exec("make", { cwd: p }, err => err ? reject(err) : resolve(undefined));
    });
    console.log(`Compiling timezone files...`);
    const files = ["africa", "antarctica", "asia", "australasia", "etcetera", "europe", "northamerica", "southamerica", "backward"];
    await fs.mkdir(`${p}/compiled`);
    await Promise.all(files.map(file => new Promise((resolve, reject) => {
        cp.exec(`zic -d ./compiled ./${file}`, { cwd: p }, err => err ? reject(err) : resolve(undefined));
    })));
    console.log(`Collecting data...`);
    const dir = (await fs.readdir(`${p}/compiled`, { recursive: true, withFileTypes: true }));
    const paths = dir.filter(x => x.isFile()).map(x => path.resolve(`${x.path}/${x.name}`));
    const concurrency = [];
    const final = [];
    const texts = [];
    let n = 1;
    for(const file of paths) {
        const name = file.slice(file.indexOf("compiled/") + 9);
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
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`${`${n++}/${paths.length}`.padEnd(10, " ")}${name}`);
            texts.push({ name, data: data.split("\n").map(x => x.slice(x.indexOf("  ") + 2)).join("\n") });
            concurrency.splice(concurrency.indexOf(promise), 1);
        });
        concurrency.push(promise);
        if(concurrency.length >= 10) {
            await Promise.race(concurrency);
        }
    }
    await Promise.all(concurrency);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log(`Processing data...`);
    first:
    for(let i = 0; i < texts.length; i++) {
        const name = texts[i].name;
        const data = texts[i].data;
        for(let f = i + 1; f < texts.length; f++) {
            const name2 = texts[f].name;
            const data2 = texts[f].data;
            if(data2 === data) {
                final.push({
                    name: name,
                    link: name2
                });
                continue first;
            }
        }
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`${`${i}/${paths.length}`.padEnd(10, " ")}${name}`);
        const lines = data.split("\n");
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
            abbrlist: abbrlist.join("|"),
            offsetlist: offsetlist.join("|"),
            untillist: untillist.join("|"),
            data: untils2.map((x, i) => abbrlist.indexOf(abbrs2[i]).toString(36) + offsetlist.indexOf(offsets2[i]).toString(36) + isdst2[i] + untillist.indexOf((i > 0 ? Math.abs(x - untils2[i-1]) : x) / 3600000).toString(36)).join("|")
        });
    }
    final.sort((a, b) => a.name.localeCompare(b.name));
    //console.log(final);
    await fs.writeFile(`${builddir}/${version}.json`, JSON.stringify({
        version,
        zones: final
    }));
    await fs.copyFile(`${builddir}/${version}.json`, `${builddir}/latest.json`);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log("Finished");
}
