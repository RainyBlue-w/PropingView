// Validate the vendor package before replacing the public copy. No vendor code is executed.
// Usage: node scripts/sync-charting-library.mjs [--check] [--source <directory>]
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const destination = path.join(workspace, 'app', 'public', 'charting_library');
const expectedVersion = 'CL v32.1.0';
const locales = ['zh', 'en'];

function expandLocales(resource) {
  return resource.includes('__LANG__') ? locales.map(locale => resource.replaceAll('__LANG__', locale)) : [resource];
}

// Webpack emits literal locale filenames and numeric-key name/hash maps. Restrict
// parsing to those formats; an unfamiliar runtime must be reviewed before copying.
export function runtimeResources(code) {
  const resources = new Set();
  const add = name => expandLocales(`bundles/${name}`).forEach(resource => resources.add(resource));
  // CSS-only chunks also have entries in the generic JS hash table, but the
  // runtime explicitly marks them loaded without requesting a JavaScript file.
  const noJs = code.slice(code.indexOf('.f.j=')).match(/\/(\^[^/]+\$)\/\.test\(\w+\)\)\w+\[\w+\]=0/);
  if (noJs && !/^[0-9^$()[\]|?+*.\-]+$/.test(noJs[1])) throw new Error('Unsupported runtime CSS-only chunk pattern.');
  const cssOnly = noJs ? new RegExp(noJs[1]) : null;
  for (const match of code.matchAll(/["']((?:__LANG__\.)?[A-Za-z0-9_-]+\.[a-f0-9]{8,}\.(?:js|css))["']/g)) add(match[1]);
  const maps = [...code.matchAll(/\{((?:\s*(?:"\d+"|\d+)\s*:\s*"[^"\\]*"\s*,?)+)\}\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g)];
  const entries = match => new Map([...match[1].matchAll(/"?(\d+)"?\s*:\s*"([^"\\]*)"/g)].map(row => [row[1], row[2]]));
  const extensions = new Set();
  for (let index = 0; index < maps.length; index++) {
    const match = maps[index];
    const suffix = code.slice(match.index + match[0].length).match(/^\s*\+\s*["']\.(js|css)["']/);
    if (!suffix) continue;
    const extension = suffix[1];
    const hashes = entries(match);
    if ([...hashes.values()].some(hash => !/^[a-f0-9]{8,}$/.test(hash))) {
      throw new Error(`Unsupported runtime ${extension} hash map; public files were not changed.`);
    }
    const previous = maps[index - 1];
    const separator = previous ? code.slice(previous.index + previous[0].length, match.index).replace(/\s/g, '') : '';
    const named = previous && previous[2] === match[2]
      && (separator === `||${match[2]})+"."+` || separator === `||${match[2]})+'.'+`);
    const names = named ? entries(previous) : new Map();
    // The unnamed form is chunkId + "." + hashMap[chunkId].
    if (!named) {
      const prefix = code.slice(Math.max(0, match.index - 100), match.index).replace(/\s/g, '');
      if (!prefix.endsWith(`${match[2]}+"."+`) && !prefix.endsWith(`${match[2]}+'.'+`)) {
        throw new Error(`Unsupported runtime ${extension} filename expression; public files were not changed.`);
      }
    }
    for (const [id, hash] of hashes) {
      if (extension !== 'js' || !cssOnly?.test(id)) add(`${names.get(id) ?? id}.${hash}.${extension}`);
    }
    extensions.add(extension);
  }
  if (!extensions.has('js') || !extensions.has('css')) {
    throw new Error('Could not read runtime JavaScript/CSS chunk maps; public files were not changed.');
  }
  return resources;
}

async function regularFile(filename) {
  try {
    const stat = await lstat(filename);
    // Webpack can emit a valid empty CSS chunk; executable/data files must not be empty.
    return stat.isFile() && !stat.isSymbolicLink() && (stat.size > 0 || filename.endsWith('.css'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function checkSource(source) {
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (!manifest.description?.startsWith(`${expectedVersion} (`)) {
    throw new Error(`Expected ${expectedVersion}; found ${manifest.description ?? manifest.version ?? 'unknown version'}.`);
  }
  const standalone = await readFile(path.join(source, 'charting_library.standalone.js'), 'utf8');
  if (!standalone.includes(manifest.description)) throw new Error('Package and standalone build identifiers do not match.');
  const resources = new Set([
    'package.json', 'charting_library.standalone.js', 'charting_library.d.ts',
    'charting_library.cjs.js', 'charting_library.esm.js', 'datafeed-api.d.ts', 'sameorigin.html',
  ]);
  const startup = [...new Set(standalone.match(/bundles\/[A-Za-z0-9_./-]+\.(?:js|css)/g) ?? [])];
  if (!startup.some(name => /^bundles\/runtime\..+\.js$/.test(name))
    || !startup.some(name => /^bundles\/library\..+\.js$/.test(name))
    || !startup.some(name => name.includes('__LANG__'))) {
    throw new Error('Could not identify standalone runtime/library/locale resources.');
  }
  for (const name of startup) for (const expanded of expandLocales(name)) resources.add(expanded);
  // Missing startup files are reported first; parsing a missing runtime cannot
  // establish whether its lazy chunks are complete.
  const missing = [];
  for (const name of resources) if (!await regularFile(path.join(source, name))) missing.push(name);
  if (missing.length) throw new Error(`Incomplete library package; missing or empty files:\n${missing.map(name => `  ${name}`).join('\n')}\nPublic files were not changed.`);
  for (const name of startup.filter(name => /^bundles\/runtime\..+\.js$/.test(name))) {
    for (const resource of runtimeResources(await readFile(path.join(source, name), 'utf8'))) resources.add(resource);
  }
  for (const name of resources) if (!await regularFile(path.join(source, name))) missing.push(name);
  if (missing.length) throw new Error(`Incomplete library package; missing or empty files:\n${missing.map(name => `  ${name}`).join('\n')}\nPublic files were not changed.`);
  // Reject symlinks/junctions anywhere in the source, including extra assets.
  let fileCount = 0;
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) throw new Error(`Source contains a symlink/junction: ${filename}`);
      if (stat.isDirectory()) await inspect(filename);
      else if (stat.isFile()) fileCount++;
      else throw new Error(`Source contains a non-regular file: ${filename}`);
    }
  }
  await inspect(source);
  return { version: manifest.description, files: fileCount, resources: resources.size };
}

async function safeWorkspacePath(filename, allowMissing = false) {
  const absolute = path.resolve(filename);
  const relative = path.relative(workspace, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside the workspace: ${absolute}`);
  }
  let current = workspace;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink/junction: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Expected directory: ${current}`);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw error;
    }
  }
  if (path.relative(absolute, await realpath(absolute))) throw new Error(`Resolved path differs: ${absolute}`);
  return absolute;
}

async function main() {
  let checkOnly = false;
  let source = path.join(workspace, 'charting_library_v32.1');
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') checkOnly = true;
    else if (args[index] === '--source' && args[index + 1] && !args[index + 1].startsWith('--')) source = path.resolve(args[++index]);
    else throw new Error('Usage: node scripts/sync-charting-library.mjs [--check] [--source <directory>]');
  }
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Source must be a real directory, not a symlink/junction.');
  source = await realpath(source);
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) {
    throw new Error('Source and destination must be separate directories.');
  }
  const result = await checkSource(source);
  console.log(`[charting-library] Validated ${result.version}: ${result.files} files, ${result.resources} required resources.`);
  if (checkOnly) return;

  // No writable operation occurs until all package validation above succeeds.
  await safeWorkspacePath(path.dirname(destination));
  await safeWorkspacePath(destination, true);
  const temporaryRoot = await safeWorkspacePath(path.join(workspace, '.tmp-webbridge'), true);
  await mkdir(temporaryRoot, { recursive: true });
  const transaction = await mkdtemp(path.join(temporaryRoot, 'charting-library-sync-'));
  const staging = path.join(transaction, 'staged');
  const backup = path.join(transaction, 'previous');
  await cp(source, staging, { recursive: true, force: false, errorOnExist: true, dereference: false });
  await checkSource(staging);
  // Re-check resolved paths immediately before moving either directory.
  await safeWorkspacePath(destination, true);
  await safeWorkspacePath(staging);
  await safeWorkspacePath(backup, true);
  let backedUp = false;
  try {
    await rename(destination, backup);
    backedUp = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (backedUp) await rename(backup, destination);
    throw error;
  }
  console.log(`[charting-library] Replaced ${destination}`);
  if (backedUp) console.log(`[charting-library] Previous library retained at ${backup}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[charting-library] ${error.message}`);
    process.exitCode = 1;
  });
}
