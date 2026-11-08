import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context.js';
import { clearDownloadCache, latestRelease, parseYmlSizes } from '../src/services/downloads.js';

describe('downloads when the GitHub API fails', () => {
  it('reads the release files instead of serving an old cached release', async () => {
    clearDownloadCache();
    let apiDown = false;
    const base = 'https://github.com/davidshoval/motionql-releases/releases';
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/repos/davidshoval/motionql-releases/releases/latest')) {
        if (apiDown) return new Response('rate limited', { status: 403 });
        return Response.json({
          tag_name: 'v1.4.0',
          published_at: '2026-11-05T09:51:54Z',
          html_url: `${base}/tag/v1.4.0`,
          assets: [{ name: 'MotionQL-1.4.0-mac-arm64.dmg', size: 100, browser_download_url: `${base}/download/v1.4.0/MotionQL-1.4.0-mac-arm64.dmg` }],
        });
      }
      if (u === `${base}/download/v1.5.0/SHA256SUMS.txt`) {
        return new Response(
          [`${'a'.repeat(64)}  MotionQL-1.5.0-mac-arm64.dmg`, `${'b'.repeat(64)}  MotionQL-1.5.0-win-x64.exe`, `${'c'.repeat(64)}  MotionQL-1.5.0-linux-amd64.deb`, `${'d'.repeat(64)}  latest.yml`].join('\n'),
        );
      }
      if (u === `${base}/latest/download/latest.yml`) return new Response('version: 1.5.0\nfiles:\n  - url: MotionQL-1.5.0-win-x64.exe\n    sha512: x\n    size: 90\npath: MotionQL-1.5.0-win-x64.exe\n');
      if (u === `${base}/latest/download/latest-mac.yml`) return new Response('version: 1.5.0\nfiles:\n  - url: MotionQL-1.5.0-mac-arm64.dmg\n    sha512: y\n    size: 100\nreleaseDate: \'2026-11-08T09:48:00.135Z\'\n');
      if (u === `${base}/download/v1.5.0/MotionQL-1.5.0-linux-amd64.deb` && init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '120' } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    let now = new Date('2026-11-08T09:00:00Z');
    const warnings: unknown[] = [];
    const ctx = { fetch: fakeFetch, now: () => now, config: { releasesRepo: 'davidshoval/motionql-releases' }, log: { warn: (o: unknown) => warnings.push(o) } } as unknown as Ctx;
    expect((await latestRelease(ctx)).version).toBe('1.4.0');

    apiDown = true;
    now = new Date(now.getTime() + 11 * 60 * 1000);
    expect(await latestRelease(ctx)).toEqual({
      version: '1.5.0',
      publishedAt: '2026-11-08T09:48:00.135Z',
      releaseNotesUrl: `${base}/tag/v1.5.0`,
      files: [
        { name: 'MotionQL-1.5.0-mac-arm64.dmg', os: 'macos', arch: 'arm64', kind: 'dmg', size: 100, url: `${base}/download/v1.5.0/MotionQL-1.5.0-mac-arm64.dmg`, sha256: 'a'.repeat(64) },
        { name: 'MotionQL-1.5.0-win-x64.exe', os: 'windows', arch: 'x64', kind: 'exe', size: 90, url: `${base}/download/v1.5.0/MotionQL-1.5.0-win-x64.exe`, sha256: 'b'.repeat(64) },
        { name: 'MotionQL-1.5.0-linux-amd64.deb', os: 'linux', arch: 'x64', kind: 'deb', size: 120, url: `${base}/download/v1.5.0/MotionQL-1.5.0-linux-amd64.deb`, sha256: 'c'.repeat(64) },
      ],
    });
    expect(warnings).toHaveLength(1);
    clearDownloadCache();
  });
});

describe('parseYmlSizes', () => {
  it('reads each file size from an electron-builder update file', () => {
    const yml = 'version: 1.5.0\nfiles:\n  - url: A.zip\n    sha512: x\n    size: 10\n  - url: A.dmg\n    sha512: y\n    size: 20\npath: A.zip\n';
    expect([...parseYmlSizes(yml)]).toEqual([['A.zip', 10], ['A.dmg', 20]]);
  });
});
