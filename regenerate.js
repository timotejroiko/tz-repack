const fs = require("node:fs/promises");
const {
    mkdir, getRemote, validateVersion, request, prepareTools, download, compile, updatePackageVersion
} = require("./build.js");

async function discoverIana() {
    const index = "https://data.iana.org/time-zones/releases/";
    const html = await (await request(index)).text();
    const releases = new Map();
    for(const match of html.matchAll(/href=["'](tzdata(\d{4}[^"'/]*)\.tar\.gz)["']/g)) {
        const [, filename, version] = match;
        if(Number(version.slice(0, 4)) < 2022) { continue; }
        validateVersion(version, "IANA");
        releases.set(version, { version, url: new URL(filename, index).href });
    }
    if(!releases.size) { throw new Error("No IANA tzdata archives discovered"); }
    return [...releases.values()].sort((a, b) => a.version.localeCompare(b.version));
}

async function discoverGtz() {
    const releases = new Map();
    for(let page = 1; ; page++) {
        const url = `https://api.github.com/repos/JodaOrg/global-tz/releases?per_page=100&page=${page}`;
        const data = await (await request(url)).json();
        if(!Array.isArray(data)) { throw new Error("Invalid GTZ releases response"); }
        if(!data.length) { break; }
        for(const release of data) {
            if(release.draft) { continue; }
            const version = release.tag_name;
            if(!/^\d{4}/.test(version) || Number(version.slice(0, 4)) < 2022) { continue; }
            validateVersion(version, "GTZ");
            // Include beta tags regardless of GitHub's prerelease flag.
            const asset = release.assets.find(asset => asset.name === `tzdata${version}.tar.gz`);
            if(!asset?.browser_download_url) { throw new Error(`Missing GTZ tzdata asset: ${version}`); }
            releases.set(version, { version, url: asset.browser_download_url });
        }
    }
    if(!releases.size) { throw new Error("No GTZ tzdata archives discovered"); }
    return [...releases.values()].sort((a, b) => a.version.localeCompare(b.version));
}

async function main() {
    try {
        const types = ["IANA", "GTZ"];
        const latest = Object.fromEntries(await Promise.all(types.map(async type => [type, await getRemote(type)])));
        const discovered = { IANA: await discoverIana(), GTZ: await discoverGtz() };
        for(const type of types) {
            if(!discovered[type].some(release => release.version === latest[type])) {
                throw new Error(`${type} latest release ${latest[type]} was not discovered`);
            }
            console.log(`Discovered ${discovered[type].length} ${type} releases; latest is ${latest[type]}`);
        }
        await mkdir(types);
        const tools = await prepareTools(latest.IANA);
        const changed = [];
        for(const type of types) {
            const file = `./build/${type}/latest.json`;
            const previous = await fs.readFile(file).catch(error => {
                if(error.code !== "ENOENT") { throw error; }
            });
            let updated = false;
            for(const [index, release] of discovered[type].entries()) {
                console.log(`${type} ${index + 1}/${discovered[type].length}: ${release.version}`);
                await download(release.version, type, release.url);
                if(await compile(release.version, type, tools)) { updated = true; }
            }
            // "beta" sorts after numbered releases; latest must come from upstream metadata.
            await fs.copyFile(`./build/${type}/${latest[type]}.json`, file);
            if(updated || !previous?.equals(await fs.readFile(file))) { changed.push(type); }
        }
        await updatePackageVersion(latest, changed);
    } finally {
        await fs.rm("./temp", { recursive: true, force: true });
    }
}

module.exports = { discoverIana, discoverGtz };

if(require.main === module) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
