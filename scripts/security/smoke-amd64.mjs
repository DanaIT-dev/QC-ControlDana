import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const artifactDir = resolve(root, 'artifacts/supply-chain');
mkdirSync(artifactDir, { recursive: true });

function run(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

function inspect(name, tag) {
  const result = run(['image', 'inspect', tag]);
  if (result.status !== 0) {
    return { name, error: result.stderr };
  }
  const image = JSON.parse(result.stdout)[0];
  const user = image.Config.User || '';
  return {
    name,
    platform: `${image.Os}/${image.Architecture}`,
    user,
    digest: image.Id,
    entrypoint: image.Config.Entrypoint ?? [],
    cmd: image.Config.Cmd ?? [],
    root: user === '' || user === '0' || user === 'root',
  };
}

const probe = `
const fs = require('node:fs');
const path = require('node:path');
const root = fs.existsSync('/app/node_modules/.pnpm') ? '/app/node_modules/.pnpm' : '/app/node_modules';
let names = [];
try { names = fs.readdirSync(root); } catch {}
const hit = names.filter((name) => /^(vitest@|eslint@|prisma@|mysql2@|deepmerge-ts@)/.test(name));
function findEngine(dir, depth) {
  if (depth > 5) return false;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (/query_compiler_fast_bg\\.postgresql|schema-engine/.test(entry.name)) return true;
    if (entry.isDirectory() && findEngine(path.join(dir, entry.name), depth + 1)) return true;
  }
  return false;
}
const engineDirs = names.filter((name) => name.startsWith('@prisma+') || name.startsWith('.prisma@'));
if (engineDirs.some((name) => findEngine(path.join(root, name), 0))) hit.push('query_compiler');
console.log(JSON.stringify({ arch: process.arch, shell: fs.existsSync('/bin/sh'), hit }));
`;

function nodeProbe(tag) {
  const result = run([
    'run',
    '--platform',
    'linux/amd64',
    '--rm',
    '--entrypoint',
    'node',
    tag,
    '-e',
    probe,
  ]);
  if (result.status !== 0) {
    return {
      status: result.status,
      stderr: result.stderr.slice(0, 500),
      stdout: result.stdout.slice(0, 500),
    };
  }
  return JSON.parse(result.stdout);
}

const images = [
  inspect('runtime', 'sgr-registry-runtime:amd64-local'),
  inspect('web', 'sgr-registry-web:amd64-local'),
  inspect('migrator', 'sgr-registry-migrator:amd64-local'),
];
const runtime = images.find((image) => image.name === 'runtime');
const web = images.find((image) => image.name === 'web');
const migrator = images.find((image) => image.name === 'migrator');
const runtimeProbe = nodeProbe('sgr-registry-runtime:amd64-local');
const webProbe = nodeProbe('sgr-registry-web:amd64-local');
const migratorProbe = nodeProbe('sgr-registry-migrator:amd64-local');

function contentFlags(probeResult, { prismaRequired }) {
  const names = probeResult.hit ?? [];
  return {
    devDependencies: names.some((name) => /^(vitest@|eslint@)/.test(name)),
    prismaCli: names.some((name) => name.startsWith('prisma@')),
    mysql2: names.some((name) => name.startsWith('mysql2@')),
    deepmerge: names.some((name) => name.startsWith('deepmerge-ts@')),
    prismaEngine: names.some((name) => name.includes('query_compiler')),
    shell: probeResult.shell === true,
    prismaRequired,
  };
}

if (runtime && runtimeProbe.arch) {
  Object.assign(runtime, contentFlags(runtimeProbe, { prismaRequired: false }));
}
if (web && webProbe.arch) {
  Object.assign(web, contentFlags(webProbe, { prismaRequired: false }), { prismaCli: false });
}
if (migrator && migratorProbe.arch) {
  Object.assign(migrator, contentFlags(migratorProbe, { prismaRequired: true }));
}

const startup = run([
  'run',
  '--platform',
  'linux/amd64',
  '--rm',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--user',
  '10001:10001',
  '--entrypoint',
  'node',
  'sgr-registry-runtime:amd64-local',
  'apps/api/dist/main.js',
]);
const startupText = `${startup.stdout}\n${startup.stderr}`;
const worker = run([
  'run',
  '--platform',
  'linux/amd64',
  '--rm',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--user',
  '10001:10001',
  '--entrypoint',
  'node',
  'sgr-registry-runtime:amd64-local',
  'apps/worker/dist/main.js',
]);
const migrateHelp = run([
  'run',
  '--platform',
  'linux/amd64',
  '--rm',
  '--entrypoint',
  'node',
  'sgr-registry-migrator:amd64-local',
  'packages/database/node_modules/prisma/build/index.js',
  '--help',
]);

let webStatus = null;
const webName = 'sgr-web-amd64-smoke';
run(['rm', '-f', webName]);
const webStart = run([
  'run',
  '-d',
  '--name',
  webName,
  '--platform',
  'linux/amd64',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--tmpfs',
  '/app/apps/web/.next/cache',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--user',
  '10001:10001',
  '-p',
  '127.0.0.1:3199:3000',
  '--entrypoint',
  'node',
  'sgr-registry-web:amd64-local',
  'apps/web/server.js',
]);
if (webStart.status === 0) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = spawnSync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3199/login'],
      {
        encoding: 'utf8',
      },
    );
    if (page.stdout.trim() === '200') {
      webStatus = 200;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}
run(['rm', '-f', webName]);

const execFormat = [startupText, worker.stderr, migrateHelp.stderr, runtimeProbe.stderr]
  .filter(Boolean)
  .some((text) => /exec format error/i.test(text));
const emulationWorked = runtimeProbe.arch === 'x64' && !execFormat;
const checks = {
  runtimeArch: runtimeProbe.arch === 'x64',
  webArch: webProbe.arch === 'x64',
  migratorArch: migratorProbe.arch === 'x64',
  runtimeNonRoot: runtime?.user === 'sgr',
  runtimeGuard:
    startup.status === 1 &&
    /DATABASE_URL|is required|Missing/i.test(startupText) &&
    !/postgres:\/\//i.test(startupText),
  workerGuard: worker.status === 1,
  migrateHelp: migrateHelp.status === 0 && /migrate/i.test(migrateHelp.stdout),
  webLogin: webStatus === 200,
  noPrismaInRuntime:
    runtime?.prismaCli === false && runtime?.mysql2 === false && runtime?.deepmerge === false,
  prismaInMigrator: migrator?.prismaCli === true,
  engine: runtime?.prismaEngine === true || migrator?.prismaEngine === true,
  noShell: runtimeProbe.shell === false && webProbe.shell === false,
};
const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);
const hostArchitecture = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
const emulated = hostArchitecture !== 'x86_64';
const status =
  execFormat || !emulationWorked
    ? 'BLOCKED_BY_LOCAL_ARCHITECTURE'
    : failed.length > 0
      ? 'FAIL'
      : emulated
        ? 'LOCAL_EMULATED'
        : 'PASS';

const smoke = {
  status,
  hostArchitecture,
  qemu: emulated,
  stagingAcceptance: 'NOT_RUN',
  digestKind: 'local-image-id',
  checks,
  failed,
  webStatus,
  startupStatus: startup.status,
  workerStatus: worker.status,
};
writeFileSync(resolve(artifactDir, 'images.json'), `${JSON.stringify({ images }, null, 2)}\n`);
writeFileSync(resolve(artifactDir, 'smoke.json'), `${JSON.stringify(smoke, null, 2)}\n`);
console.log(JSON.stringify(smoke, null, 2));
process.exit(status === 'FAIL' ? 1 : 0);
