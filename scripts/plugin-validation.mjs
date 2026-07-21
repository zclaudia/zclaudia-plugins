import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  collectDirectoryEntries,
  PLUGIN_LIMITS,
  readZip,
  resolveSafeLinkTarget,
} from './plugin-archive.mjs';

const ALLOWED_ROOT_ENTRIES = new Set([
  'LICENSE',
  'README.md',
  'THIRD_PARTY_LICENSES.txt',
  'dist',
  'node_modules',
  'package.json',
  'plugin.json',
]);
const FORBIDDEN_PLUGIN_COMPONENTS = new Set([
  '.cache',
  '.git',
  '__tests__',
  'coverage',
  'src',
  'test',
  'tests',
]);
const NATIVE_EXTENSIONS = new Set(['.dll', '.dylib', '.exe', '.node', '.so']);
const RUNTIME_JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

function fail(message) {
  throw new Error(`Plugin validation failed: ${message}`);
}

function parseJson(entry, description) {
  try {
    return JSON.parse(entry.data.toString('utf8'));
  } catch (error) {
    fail(`${description} is not valid JSON: ${error.message}`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('plugin.json must contain an object.');
  }
  for (const field of ['id', 'name', 'version', 'main']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      fail(`plugin.json field ${field} must be a non-empty string.`);
    }
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail(`plugin.json version ${manifest.version} is not a supported semantic version.`);
  }
  if (manifest.executionMode !== 'main') fail('plugin.json executionMode must be "main".');
  if (
    manifest.main.includes('\\') ||
    path.posix.isAbsolute(manifest.main) ||
    manifest.main.split('/').some(component => component === '..' || component === '')
  ) {
    fail(`plugin.json main path is unsafe: ${manifest.main}.`);
  }
}

function hasNativeMagic(data) {
  if (data.length >= 4) {
    if (data[0] === 0x7f && data.subarray(1, 4).toString('ascii') === 'ELF') return true;
    const magic = data.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true;
  }
  return data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a;
}

function validateEntries(entries, manifest, limits) {
  if (entries.length > limits.fileCount) fail(`file count exceeds ${limits.fileCount}.`);
  let totalSize = 0;
  const entryByName = new Map();
  for (const entry of entries) {
    if (entryByName.has(entry.name)) fail(`duplicate entry ${entry.name}.`);
    entryByName.set(entry.name, entry);
    totalSize += entry.data.length;
    if (entry.data.length > limits.fileSize) {
      fail(`${entry.name} exceeds the ${limits.fileSize}-byte file-size limit.`);
    }
  }
  if (totalSize > limits.unpackedSize) fail(`unpacked size exceeds ${limits.unpackedSize} bytes.`);

  for (const entry of entries) {
    const components = entry.name.split('/');
    const root = components[0];
    if (!ALLOWED_ROOT_ENTRIES.has(root)) fail(`unexpected archive-root entry ${root}.`);
    const inDependencies = root === 'node_modules';
    if (
      !inDependencies &&
      components.some(component => FORBIDDEN_PLUGIN_COMPONENTS.has(component))
    ) {
      fail(`development-only path is not allowed: ${entry.name}.`);
    }
    const basename = components.at(-1);
    if (basename === '.DS_Store' || basename === '.env' || basename.startsWith('.env.')) {
      fail(`environment or cache file is not allowed: ${entry.name}.`);
    }
    if (/npm-debug\.log|pnpm-debug\.log|yarn-error\.log/.test(basename)) {
      fail(`development log is not allowed: ${entry.name}.`);
    }
    const extension = path.posix.extname(basename).toLowerCase();
    if (['.key', '.p12', '.pem', '.pfx'].includes(extension)) {
      fail(`potential secret/key file is not allowed: ${entry.name}.`);
    }
    if (NATIVE_EXTENSIONS.has(extension) || (entry.type === 'file' && hasNativeMagic(entry.data))) {
      fail(`native executable is not allowed in an any artifact: ${entry.name}.`);
    }
    if (/node_modules\/@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-/.test(entry.name)) {
      fail(`platform-specific Claude Agent SDK package is not allowed: ${entry.name}.`);
    }
    if (entry.type === 'symlink') resolveSafeLinkTarget(entry.name, entry.target);
    if (RUNTIME_JAVASCRIPT_EXTENSIONS.has(extension)) {
      const source = entry.data.toString('utf8');
      if (/['"]@zclaudia\/shared(?:\/[^'"]*)?['"]/.test(source)) {
        fail(`runtime JavaScript imports @zclaudia/shared: ${entry.name}.`);
      }
    }
    if (basename === 'package.json') {
      const packageJson = parseJson(entry, entry.name);
      const sections = [
        packageJson.dependencies,
        packageJson.optionalDependencies,
        packageJson.peerDependencies,
        packageJson.devDependencies,
      ];
      for (const dependencies of sections) {
        if (!dependencies || typeof dependencies !== 'object') continue;
        for (const value of Object.values(dependencies)) {
          if (typeof value === 'string' && value.startsWith('workspace:')) {
            fail(`workspace dependency found in ${entry.name}.`);
          }
        }
      }
    }
  }

  for (const entry of entries.filter(candidate => candidate.type === 'symlink')) {
    const target = resolveSafeLinkTarget(entry.name, entry.target);
    const targetExists =
      entryByName.has(target) || entries.some(candidate => candidate.name.startsWith(`${target}/`));
    if (!targetExists) fail(`symlink target is missing: ${entry.name} -> ${entry.target}.`);
  }

  const main = entryByName.get(manifest.main);
  if (!main || main.type !== 'file') fail(`main entrypoint does not exist: ${manifest.main}.`);
  if (!manifest.main.startsWith('dist/')) fail('main entrypoint must be under dist/.');

  const packageEntry = entryByName.get('package.json');
  if (packageEntry) {
    const packageJson = parseJson(packageEntry, 'package.json');
    if (packageJson.version !== manifest.version) {
      fail(
        `package version ${packageJson.version} does not match plugin version ${manifest.version}.`
      );
    }
  }

  const agent = manifest.id.replace(/^com\.zclaudia\./, '');
  if (!['claude', 'codex', 'cursor'].includes(agent)) fail(`unsupported plugin id ${manifest.id}.`);
  const hasNodeModules = entries.some(entry => entry.name.startsWith('node_modules/'));
  if (agent === 'claude') {
    if (!entryByName.has('node_modules/@anthropic-ai/claude-agent-sdk')) {
      fail('Claude artifact does not contain @anthropic-ai/claude-agent-sdk.');
    }
    if (!entryByName.has('THIRD_PARTY_LICENSES.txt')) {
      fail('Claude artifact does not contain THIRD_PARTY_LICENSES.txt.');
    }
  } else if (hasNodeModules) {
    fail(`${agent} artifact must not vendor node_modules.`);
  }

  return { agent, fileCount: entries.length, manifest, unpackedSize: totalSize };
}

async function validateDirectorySymlinks(root, entries) {
  const resolvedRoot = await realpath(root);
  for (const entry of entries.filter(candidate => candidate.type === 'symlink')) {
    const absolute = path.join(root, ...entry.name.split('/'));
    let resolved;
    try {
      resolved = await realpath(absolute);
    } catch (error) {
      fail(`symlink is broken: ${entry.name} (${error.message}).`);
    }
    const relative = path.relative(resolvedRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail(`symlink escapes the plugin root: ${entry.name}.`);
    }
  }
}

export async function validatePlugin(inputPath, options = {}) {
  const limits = options.limits ?? PLUGIN_LIMITS;
  const absolute = path.resolve(inputPath);
  const details = await stat(absolute);
  let entries;
  let kind;
  if (details.isDirectory()) {
    kind = 'directory';
    entries = await collectDirectoryEntries(absolute);
    await validateDirectorySymlinks(absolute, entries);
  } else if (details.isFile()) {
    kind = 'archive';
    entries = await readZip(absolute, limits);
  } else {
    fail(`${inputPath} is neither a directory nor a regular archive.`);
  }

  const manifestEntry = entries.find(entry => entry.name === 'plugin.json');
  if (!manifestEntry || manifestEntry.type !== 'file')
    fail('plugin.json is missing from the root.');
  const manifest = parseJson(manifestEntry, 'plugin.json');
  validateManifest(manifest);
  return { kind, path: absolute, ...validateEntries(entries, manifest, limits) };
}
