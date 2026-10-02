import type { Ctx } from '../context.js';
import { AppError } from '../errors.js';

export interface DownloadFile {
  name: string;
  os: 'macos' | 'windows' | 'linux';
  arch: 'arm64' | 'x64' | 'universal';
  kind: 'dmg' | 'zip' | 'exe' | 'msi' | 'appimage' | 'deb' | 'rpm';
  size: number;
  sha256?: string;
  url: string;
}

export interface LatestRelease {
  version: string;
  publishedAt: string | null;
  releaseNotesUrl: string;
  files: DownloadFile[];
}

const KINDS: [RegExp, DownloadFile['kind'], DownloadFile['os']][] = [
  [/\.dmg$/i, 'dmg', 'macos'],
  [/mac.*\.zip$|darwin.*\.zip$/i, 'zip', 'macos'],
  [/\.exe$/i, 'exe', 'windows'],
  [/\.msi$/i, 'msi', 'windows'],
  [/\.appimage$/i, 'appimage', 'linux'],
  [/\.deb$/i, 'deb', 'linux'],
  [/\.rpm$/i, 'rpm', 'linux'],
];

/** Maps an electron-builder artifact name to OS, arch and kind; anything else (blockmaps, yml) is skipped. */
export function classifyAsset(name: string): Pick<DownloadFile, 'os' | 'arch' | 'kind'> | undefined {
  const match = KINDS.find(([re]) => re.test(name));
  if (!match) return undefined;
  const [, kind, os] = match;
  const arch: DownloadFile['arch'] = /arm64|aarch64/i.test(name) ? 'arm64' : /universal/i.test(name) ? 'universal' : 'x64';
  return { os, arch, kind };
}

/** SHA256SUMS.txt lines: "<hex>  <file name>" (sha256sum format). */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

let cache: { at: number; value: LatestRelease } | undefined;
const CACHE_MS = 10 * 60 * 1000;

export function clearDownloadCache() {
  cache = undefined;
}

/** The latest release of the public releases repo, cached for 10 minutes. */
export async function latestRelease(ctx: Ctx): Promise<LatestRelease> {
  const now = ctx.now().getTime();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'motionql-backend' };
  if (ctx.config.githubToken) headers.authorization = `Bearer ${ctx.config.githubToken}`;
  const res = await ctx.fetch(`https://api.github.com/repos/${ctx.config.releasesRepo}/releases/latest`, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new AppError(404, 'no_release', 'No release has been published yet.');
  if (!res.ok) {
    if (cache) return cache.value;
    throw new AppError(502, 'downloads_unavailable', 'Downloads are temporarily unavailable. Please try again shortly.');
  }
  const release = (await res.json()) as { tag_name: string; published_at: string | null; html_url: string; assets: GithubAsset[] };
  const sumsAsset = release.assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
  let sums = new Map<string, string>();
  if (sumsAsset) {
    const sumsRes = await ctx.fetch(sumsAsset.browser_download_url, { headers: { 'user-agent': 'motionql-backend' }, signal: AbortSignal.timeout(10_000) });
    if (sumsRes.ok) sums = parseSums(await sumsRes.text());
  }
  const files: DownloadFile[] = release.assets.flatMap((a) => {
    const kind = classifyAsset(a.name);
    if (!kind) return [];
    const sha256 = sums.get(a.name);
    return [{ name: a.name, ...kind, size: a.size, url: a.browser_download_url, ...(sha256 ? { sha256 } : {}) }];
  });
  const value: LatestRelease = {
    version: release.tag_name.replace(/^v/, ''),
    publishedAt: release.published_at,
    releaseNotesUrl: release.html_url,
    files,
  };
  cache = { at: now, value };
  return value;
}
