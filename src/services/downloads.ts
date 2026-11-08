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

const UA = { 'user-agent': 'motionql-backend' };

/** electron-builder's latest*.yml files: "- url: <name>" entries, each followed by "size: <bytes>". */
export function parseYmlSizes(text: string): Map<string, number> {
  const sizes = new Map<string, number>();
  let name: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const url = /^\s*-\s*url:\s*(\S+)\s*$/.exec(line);
    if (url) {
      name = url[1];
      continue;
    }
    const size = /^\s*size:\s*(\d+)\s*$/.exec(line);
    if (size && name) {
      sizes.set(name, Number(size[1]));
      name = undefined;
    }
  }
  return sizes;
}

/** The latest release from the API: tag, date and every asset with its size. */
async function fromApi(ctx: Ctx): Promise<LatestRelease> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', ...UA };
  if (ctx.config.githubToken) headers.authorization = `Bearer ${ctx.config.githubToken}`;
  const res = await ctx.fetch(`https://api.github.com/repos/${ctx.config.releasesRepo}/releases/latest`, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new AppError(404, 'no_release', 'No release has been published yet.');
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
  const release = (await res.json()) as { tag_name: string; published_at: string | null; html_url: string; assets: GithubAsset[] };
  const sumsAsset = release.assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
  let sums = new Map<string, string>();
  if (sumsAsset) {
    const sumsRes = await ctx.fetch(sumsAsset.browser_download_url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (sumsRes.ok) sums = parseSums(await sumsRes.text());
  }
  const files: DownloadFile[] = release.assets.flatMap((a) => {
    const kind = classifyAsset(a.name);
    if (!kind) return [];
    const sha256 = sums.get(a.name);
    return [{ name: a.name, ...kind, size: a.size, url: a.browser_download_url, ...(sha256 ? { sha256 } : {}) }];
  });
  return { version: release.tag_name.replace(/^v/, ''), publishedAt: release.published_at, releaseNotesUrl: release.html_url, files };
}

/**
 * The latest release without the API (whose unauthenticated limits and outages are shared by every app on the host's
 * IP), from release files only: releases/latest/download/latest*.yml give the version, the release date and most
 * sizes, SHA256SUMS.txt names every installer, and a HEAD request sizes the rest.
 */
async function fromReleaseFiles(ctx: Ctx): Promise<LatestRelease> {
  const base = `https://github.com/${ctx.config.releasesRepo}/releases`;
  const text = async (url: string) => {
    const res = await ctx.fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    return res.ok ? res.text() : '';
  };
  const ymls = await Promise.all(['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].map((f) => text(`${base}/latest/download/${f}`)));
  const versions = new Set(ymls.flatMap((y) => /^version:\s*'?([\w.+-]+)'?\s*$/m.exec(y)?.[1] ?? []));
  if (versions.size !== 1) throw new Error(`release files name ${versions.size ? [...versions].join(', ') : 'no'} version`);
  const [version] = versions;
  const tag = `v${version}`;
  const asset = (name: string) => `${base}/download/${tag}/${encodeURIComponent(name)}`;
  const sizes = new Map<string, number>();
  let publishedAt: string | null = null;
  for (const yml of ymls) {
    for (const [name, size] of parseYmlSizes(yml)) sizes.set(name, size);
    publishedAt ??= /^releaseDate:\s*'?([^'\s]+)'?\s*$/m.exec(yml)?.[1] ?? null;
  }
  const sums = parseSums(await text(asset('SHA256SUMS.txt')));
  if (sums.size === 0) throw new Error(`no SHA256SUMS.txt in ${tag}`);
  const files = await Promise.all(
    [...sums].flatMap(([name, sha256]) => {
      const kind = classifyAsset(name);
      if (!kind) return [];
      return [(async (): Promise<DownloadFile> => {
        let size = sizes.get(name);
        if (size === undefined) {
          const head = await ctx.fetch(asset(name), { method: 'HEAD', headers: UA, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
          size = Number(head?.headers.get('content-length') ?? 0) || 0;
        }
        return { name, ...kind, size, url: asset(name), sha256 };
      })()];
    }),
  );
  return { version, publishedAt, releaseNotesUrl: `${base}/tag/${tag}`, files };
}

/**
 * The latest release of the public releases repo, cached for 10 minutes. When the API fails it reads the release files
 * instead, and only when both fail does it serve the last answer it had.
 */
export async function latestRelease(ctx: Ctx): Promise<LatestRelease> {
  const now = ctx.now().getTime();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: LatestRelease;
  try {
    value = await fromApi(ctx);
  } catch (apiError) {
    if (apiError instanceof AppError) throw apiError;
    try {
      value = await fromReleaseFiles(ctx);
      ctx.log.warn({ err: apiError }, 'downloads: GitHub API failed; read the release files instead');
    } catch (pageError) {
      ctx.log.warn({ apiError, pageError }, 'downloads: GitHub API and release files both failed');
      if (cache) return cache.value;
      throw new AppError(502, 'downloads_unavailable', 'Downloads are temporarily unavailable. Please try again shortly.');
    }
  }
  cache = { at: now, value };
  return value;
}
