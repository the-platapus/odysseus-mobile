// App updates from this repo's GitHub releases: whether one is newer than the running build, and
// which file of it to install. No React Native imports, so it can be tested outside the app.
//
// .github/workflows/mobile-build.yml publishes every push to master as a prerelease tagged
// "build-<run number>", and every pushed "v1.2.3" tag as a release. app.json's version only
// changes for tagged releases, so builds from master are told apart by their run number, which
// app.config.js stores in the builds GitHub Actions makes (RunningBuild.release).

export type GithubAsset = {
  name: string;
  size: number;
  browser_download_url: string;
  /** 'uploaded' once the upload finished. */
  state?: string;
};

export type GithubRelease = {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  /** The commit it was built from: the workflow passes the full SHA as --target. */
  target_commitish?: string;
  published_at?: string | null;
  assets: GithubAsset[];
};

/** The app that's running. */
export type RunningBuild = {
  /** app.json's expo.version. */
  version: string;
  /** The release a GitHub Actions build is published as. null for local, EAS and development builds. */
  release: { tag: string; runNumber: number; commit: string; prerelease: boolean } | null;
};

export type Update = {
  release: GithubRelease;
  /** "v1.2.0", or "v1.0.0 build 12" for a build from master. */
  label: string;
  /** What to install on this platform (the .apk on Android, the .ipa on iOS), if the release has it. */
  asset: GithubAsset | null;
  notes: string;
};

// --- GitHub API ------------------------------------------------------------------------------

// /releases/latest skips prereleases, and every build from master is one, so read the list.
export const releasesUrl = (repo: string, perPage = 20) => `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`;

/**
 * The repo's newest releases. Throws when offline, after `timeoutMs`, or when rate-limited
 * (GitHub allows 60 requests an hour per IP address without a token).
 */
export async function fetchReleases(repo: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<GithubRelease[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(releasesUrl(repo), {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
    const releases = await res.json();
    if (!Array.isArray(releases)) throw new Error('GitHub releases: not a list');
    return releases;
  } finally {
    clearTimeout(timer);
  }
}

/** The update to offer, or null when the running build is the newest. */
export async function checkForUpdate(
  repo: string,
  running: RunningBuild,
  platform: string,
  abis: string[] = [],
  fetchImpl: typeof fetch = fetch
): Promise<Update | null> {
  return findUpdate(await fetchReleases(repo, fetchImpl), running, platform, abis);
}

// --- Versions --------------------------------------------------------------------------------

type Version = { numbers: number[]; pre: string[] };

/** "v1.2.0", "1.2", "1.2.0-beta.1" -> its parts; anything else (like "build-12") -> null. */
function parseVersion(text: string): Version | null {
  const match = text.trim().match(/^v?(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const numbers = match[1].split('.').map(Number);
  while (numbers.length < 3) numbers.push(0);
  return { numbers, pre: match[2] ? match[2].split('.') : [] };
}

/**
 * Semver order: <0 when `a` is older than `b`, >0 when newer. A prerelease comes before its
 * release ("1.2.0-beta" < "1.2.0"). Text that isn't a version compares equal to anything.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] - y.numbers[i];
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1; // numbers sort before words
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/** "build-12" -> 12, for the prereleases built from master. */
export function runNumberOf(tag: string): number | null {
  const match = tag.match(/^build-(\d+)$/);
  return match ? Number(match[1]) : null;
}

// The workflow names its files "Odysseus-<app.json version>-<commit>[-unsigned].apk|ipa".
const VERSION_IN_FILE_NAME = /-v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-[0-9a-f]{7,40}(?:-unsigned)?\.(?:apk|ipa)$/i;

/** The app version a release holds: its tag when that's a version, else what its file names say. */
export function releaseVersion(r: GithubRelease): string | null {
  if (parseVersion(r.tag_name)) return r.tag_name.trim().replace(/^v/, '');
  for (const asset of r.assets) {
    const match = asset.name.match(VERSION_IN_FILE_NAME);
    if (match) return match[1];
  }
  return null;
}

/** "v1.2.0", or "v1.0.0 build 12" for a build from master. */
export function releaseLabel(r: GithubRelease): string {
  const version = releaseVersion(r);
  const run = runNumberOf(r.tag_name);
  if (!version) return r.tag_name;
  return run === null ? `v${version}` : `v${version} build ${run}`;
}

export const runningLabel = (running: RunningBuild) =>
  running.release?.prerelease ? `v${running.version} build ${running.release.runNumber}` : `v${running.version}`;

/**
 * Whether `r` is newer than the running build. The version decides; with the same version, the
 * run number (both builds from GitHub Actions). Without one to compare, it isn't newer: a local
 * build can't tell which builds from master it's ahead of.
 */
export function isNewer(r: GithubRelease, running: RunningBuild): boolean {
  if (running.release && r.target_commitish === running.release.commit) return false; // same code
  const version = releaseVersion(r);
  const byVersion = version ? compareVersions(version, running.version) : 0;
  if (byVersion !== 0) return byVersion > 0;
  const run = runNumberOf(r.tag_name);
  return run !== null && running.release !== null && run > running.release.runNumber;
}

const newestFirst = (a: GithubRelease, b: GithubRelease) => {
  const [va, vb] = [releaseVersion(a), releaseVersion(b)];
  return (
    (va && vb ? compareVersions(vb, va) : 0) ||
    (runNumberOf(b.tag_name) ?? -1) - (runNumberOf(a.tag_name) ?? -1) ||
    Date.parse(b.published_at ?? '') - Date.parse(a.published_at ?? '') ||
    0
  );
};

// --- Choosing the update ---------------------------------------------------------------------

// Longest first: "x86" is part of "x86_64".
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const abiIn = (name: string) => ABIS.find((abi) => name.includes(abi)) ?? null;

/**
 * What to install on `platform`: the .apk on Android, the .ipa on iOS. If there's one APK per
 * ABI, the one for this phone (`abis`, preferred first); else one that names no ABI.
 */
export function pickAsset(assets: GithubAsset[], platform: string, abis: string[] = []): GithubAsset | null {
  const extension = platform === 'android' ? '.apk' : platform === 'ios' ? '.ipa' : null;
  if (!extension) return null;
  const files = assets.filter((a) => a.name.toLowerCase().endsWith(extension) && (a.state ?? 'uploaded') === 'uploaded');
  const fits = files.filter((a) => {
    const abi = abiIn(a.name);
    return !abi || !abis.length || abis.includes(abi);
  });
  return fits.find((a) => abis.length > 0 && abiIn(a.name) === abis[0]) ?? fits.find((a) => !abiIn(a.name)) ?? fits[0] ?? null;
}

/**
 * The newest release that's newer than the running build. Drafts never count. Prereleases
 * (builds from master) only count for a build from master: a tagged release, or a local build,
 * only hears about tagged releases. A release with nothing to install on this platform (its
 * build failed there) is passed over for an older one that has it, if that's newer too.
 */
export function findUpdate(releases: GithubRelease[], running: RunningBuild, platform: string, abis: string[] = []): Update | null {
  const newer = releases
    .filter((r) => !r.draft && (!r.prerelease || running.release?.prerelease) && isNewer(r, running))
    .sort(newestFirst);
  const release = newer.find((r) => pickAsset(r.assets, platform, abis)) ?? newer[0];
  if (!release) return null;
  return { release, label: releaseLabel(release), asset: pickAsset(release.assets, platform, abis), notes: releaseNotes(release.body) };
}

/** Release notes as plain text, cut to about `max` characters: links keep their text, Markdown marks go. */
export function releaseNotes(body: string | null | undefined, max = 600): string {
  const text = (body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(end > max * 0.6 ? cut.slice(0, end) : cut).trimEnd()}…`;
}
