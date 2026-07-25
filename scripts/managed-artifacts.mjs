import { createHash } from 'node:crypto';

const DEFAULT_ARCHIVE_LIMIT = 256 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateDownloadUrl(value, allowHttp) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Artifact URLs may not contain credentials.');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error(`Artifact URL must use HTTPS: ${url}`);
  }
  return url;
}

export function currentPlatformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].includes(key)
    ? key
    : undefined;
}

export function managedArtifactEntries(compatibility, options = {}) {
  const managed = compatibility.managedInstall;
  if (!managed) return [];
  const platforms = options.allPlatforms ? undefined : new Set([options.platform]);
  const entries = [];
  for (const version of managed.versions) {
    for (const [platform, artifact] of Object.entries(version.artifacts)) {
      if (platforms && !platforms.has(platform)) continue;
      entries.push({
        runtime: compatibility.runtime,
        version: version.version,
        platform,
        artifact,
      });
    }
  }
  return entries;
}

export async function verifyManagedArtifact(
  artifact,
  { fetchImpl = globalThis.fetch, allowHttp = false, maxBytes = DEFAULT_ARCHIVE_LIMIT } = {}
) {
  let url = validateDownloadUrl(artifact.url, allowHttp);
  let response;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    response = await fetchImpl(url, { redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error(`Artifact redirect from ${url} has no Location header.`);
    url = validateDownloadUrl(new URL(location, url).toString(), allowHttp);
  }
  if (!response?.ok) {
    throw new Error(`Artifact download failed with HTTP ${response?.status ?? 'unknown'}: ${url}`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Artifact exceeds the ${maxBytes}-byte archive limit.`);
  }
  if (artifact.size !== undefined && contentLength > 0 && contentLength !== artifact.size) {
    throw new Error(
      `Artifact size mismatch for ${artifact.url}: expected ${artifact.size}, got ${contentLength}.`
    );
  }
  if (!response.body) throw new Error(`Artifact response has no body: ${artifact.url}`);

  const hash = createHash('sha256');
  let size = 0;
  for await (const chunkValue of response.body) {
    const chunk = Buffer.from(chunkValue);
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes}-byte archive limit.`);
    hash.update(chunk);
  }
  if (artifact.size !== undefined && size !== artifact.size) {
    throw new Error(
      `Artifact size mismatch for ${artifact.url}: expected ${artifact.size}, got ${size}.`
    );
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== artifact.sha256.toLowerCase()) {
    throw new Error(
      `Artifact SHA-256 mismatch for ${artifact.url}: expected ${artifact.sha256.toLowerCase()}, got ${sha256}.`
    );
  }
  return { finalUrl: url.toString(), sha256, size };
}
