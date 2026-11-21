import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = fileURLToPath(new URL('./dist', import.meta.url));
await mkdir(dist, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (process.platform === 'darwin') {
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`;
  const nodeInclude = process.env['KIMI_DESKTOP_ELECTRON_HEADERS_DIR'];
  if (
    nodeInclude === undefined ||
    !isAbsolute(nodeInclude) ||
    !existsSync(join(nodeInclude, 'node_api.h'))
  ) {
    throw new Error(
      'Set KIMI_DESKTOP_ELECTRON_HEADERS_DIR to the matching Electron include/node headers directory before building macOS screenshot addons. Bun headers are not Electron headers.',
    );
  }
  run('xcrun', [
    'clang++',
    '-std=c++17',
    '-O2',
    '-fobjc-arc',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-target',
    target,
    '-DNAPI_VERSION=8',
    '-I',
    nodeInclude,
    '-framework',
    'AppKit',
    'macos/overlay.mm',
    '-o',
    'dist/screenshot-overlay.node',
  ]);
  run('xcrun', [
    'clang++',
    '-std=c++17',
    '-O2',
    '-fobjc-arc',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-target',
    target,
    '-DNAPI_VERSION=8',
    '-I',
    nodeInclude,
    '-framework',
    'AppKit',
    '-weak_framework',
    'ScreenCaptureKit',
    'macos/capture.mm',
    '-o',
    'dist/screenshot-capture.node',
  ]);
  run('xcrun', [
    'swiftc',
    '-target',
    target,
    'macos/main.swift',
    '-O',
    '-framework',
    'AppKit',
    '-framework',
    'CoreGraphics',
    '-framework',
    'Foundation',
    '-o',
    'dist/screenshot-window-list',
  ]);
} else if (process.platform === 'win32') {
  const clArgs = [
    '/nologo',
    '/std:c++20',
    '/O2',
    '/EHsc',
    '/Fodist/main.obj',
    'windows/main.cpp',
    '/link',
    'user32.lib',
    'dwmapi.lib',
    'ole32.lib',
    'uuid.lib',
    '/out:dist/screenshot-window-list.exe',
  ];
  const programRoots = [
    ...new Set(
      [
        process.env['ProgramFiles(x86)'],
        process.env['ProgramFiles'],
        'C:\\Program Files (x86)',
        'C:\\Program Files',
      ].filter(Boolean),
    ),
  ];
  const installations = [];
  for (const base of programRoots) {
    const vswhere = join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!existsSync(vswhere)) continue;
    const probe = spawnSync(
      vswhere,
      [
        '-all',
        '-prerelease',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { encoding: 'utf8' },
    );
    if (!probe.error && probe.status === 0)
      installations.push(...probe.stdout.split(/\r?\n/).filter(Boolean));
  }
  for (const base of programRoots) {
    const visualStudio = join(base, 'Microsoft Visual Studio');
    if (!existsSync(visualStudio)) continue;
    const versions = readdirSync(visualStudio, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .sort((a, b) => Number(b.name) - Number(a.name));
    for (const version of versions) {
      const directory = join(visualStudio, version.name);
      const editions = readdirSync(directory, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      );
      editions.sort(
        (a, b) =>
          Number(b.name === 'BuildTools') - Number(a.name === 'BuildTools') ||
          a.name.localeCompare(b.name),
      );
      installations.push(...editions.map((edition) => join(directory, edition.name)));
    }
  }
  const vcvars = [...new Set(installations)]
    .map((installation) => join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))
    .find((filename) => existsSync(filename));
  if (vcvars !== undefined) {
    const buildDir = await mkdtemp(join(dist, '.msvc-'));
    const script = join(buildDir, 'build.cmd');
    try {
      const args = clArgs.map((argument) =>
        argument.startsWith('/Fo') ? `/Fo"${join(buildDir, 'main.obj')}"` : argument,
      );
      const installer = programRoots
        .map((base) => join(base, 'Microsoft Visual Studio', 'Installer'))
        .find((directory) => existsSync(join(directory, 'vswhere.exe')));
      const localPath = installer === undefined ? '' : `set "PATH=${installer};%PATH%"\r\n`;
      await writeFile(
        script,
        `@echo off\r\n${localPath}call "${vcvars}"\r\nif errorlevel 1 exit /b 1\r\nwhere cl\r\ncl ${args.join(' ')}\r\n`,
      );
      run('cmd.exe', ['/d', '/c', script]);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  } else {
    run('cl', clArgs);
  }
}
