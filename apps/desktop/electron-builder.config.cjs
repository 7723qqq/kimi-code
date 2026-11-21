'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const notarize = process.env.KIMI_DESKTOP_NOTARIZE === 'true';

const localElectronDist = path.resolve(__dirname, '..', '..', 'node_modules', 'electron', 'dist');
const electronDist = fs.existsSync(path.join(localElectronDist, 'version'))
  ? localElectronDist
  : undefined;

const azureTrustedSigning = process.env.KIMI_DESKTOP_AZURE_TRUSTED_SIGNING === 'true';

const canary = process.env.KIMI_DESKTOP_CANARY === 'true';
const preview = process.env.KIMI_DESKTOP_PREVIEW === 'true';
if (canary && preview) throw new Error('Canary and Preview builds are mutually exclusive');
const iconChannel = preview ? 'preview' : canary ? 'canary' : null;

const artifactName = preview
  ? 'KimiCodePreview-${version}-${os}-${arch}.${ext}'
  : canary
    ? 'KimiCodeCanary-${version}-${os}-${arch}.${ext}'
    : 'KimiCode-${version}-${os}-${arch}.${ext}';

async function embedTahoeIconCatalog(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (iconChannel) return;
  const iconPkg = path.join(__dirname, 'build', 'AppIcon.icon');
  if (!fs.existsSync(iconPkg)) return;
  const actool = execFileSync('xcrun', ['-f', 'actool'], { encoding: 'utf8' }).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-car-'));
  execFileSync(
    actool,
    [
      iconPkg,
      '--compile',
      tmp,
      '--output-format',
      'human-readable-text',
      '--notices',
      '--warnings',
      '--errors',
      '--output-partial-info-plist',
      path.join(tmp, 'partial.plist'),
      '--app-icon',
      'AppIcon',
      '--include-all-app-icons',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '26.0',
      '--platform',
      'macosx',
    ],
    { stdio: 'inherit' },
  );

  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  fs.copyFileSync(
    path.join(tmp, 'Assets.car'),
    path.join(appDir, 'Contents', 'Resources', 'Assets.car'),
  );
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleIconName string AppIcon', plist]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconName AppIcon', plist]);
  }
  console.log(
    '[afterPack] embedded Assets.car (CFBundleIconName=AppIcon; .icns kept as pre-Tahoe fallback)',
  );
}

function patchCanaryUpdateConfig(context) {
  if (!canary) return;
  Object.defineProperty(context.packager.appInfo, 'updaterCacheDirName', {
    value: 'kimi-code-canary-updater',
    configurable: true,
  });
  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const yml =
    context.electronPlatformName === 'darwin'
      ? path.join(appDir, 'Contents', 'Resources', 'app-update.yml')
      : path.join(context.appOutDir, 'resources', 'app-update.yml');
  const src = fs.readFileSync(yml, 'utf8');
  const lineRe = /^updaterCacheDirName: .+$/m;
  const next = lineRe.test(src)
    ? src.replace(lineRe, 'updaterCacheDirName: kimi-code-canary-updater')
    : `${src}updaterCacheDirName: kimi-code-canary-updater\n`;
  fs.writeFileSync(yml, next);
  console.log(
    '[afterPack] canary updaterCacheDirName=kimi-code-canary-updater written into app-update.yml',
  );
}

const LINUX_METAINFO_TEMPLATE = 'com.kimi.code.desktop.metainfo.xml';
const LINUX_METAINFO_NAME = canary
  ? 'com.kimi.code.desktop.canary.metainfo.xml'
  : LINUX_METAINFO_TEMPLATE;

function injectLinuxMetainfo(context) {
  if (context.electronPlatformName !== 'linux') return;
  const template = fs.readFileSync(
    path.join(__dirname, 'build', 'linux', LINUX_METAINFO_TEMPLATE),
    'utf8',
  );
  const xml = (
    canary
      ? template
          .replaceAll('com.kimi.code.desktop', 'com.kimi.code.desktop.canary')
          .replaceAll('Kimi Code', 'Kimi Code Canary')
          .replaceAll('kimi-code', 'kimi-code-canary')
      : template
  )
    .replaceAll('@APP_VERSION@', context.packager.appInfo.version)
    .replaceAll('@RELEASE_DATE@', new Date().toISOString().slice(0, 10));
  const appDirTarget = path.join(context.appOutDir, 'usr', 'share', 'metainfo');
  fs.mkdirSync(appDirTarget, { recursive: true });
  fs.writeFileSync(path.join(appDirTarget, LINUX_METAINFO_NAME), xml);
  const debTarget = path.join(context.outDir, 'linux-metainfo');
  fs.mkdirSync(debTarget, { recursive: true });
  fs.writeFileSync(path.join(debTarget, LINUX_METAINFO_NAME), xml);
}

module.exports = {
  appId: preview
    ? 'com.kimi.code.desktop.preview'
    : canary
      ? 'com.kimi.code.desktop.canary'
      : 'com.kimi.code.desktop',
  productName: preview ? 'Kimi Code Preview' : canary ? 'Kimi Code Canary' : 'Kimi Code',
  copyright: 'Copyright © Moonshot AI',
  electronDist,

  beforePack: async (context) => {
    const { KIMI_CORE_VERSION } = await import('./scripts/kimi-core-version.mjs');
    const { createHash } = require('node:crypto');
    const arch = require('electron-builder').Arch[context.arch];
    const root = path.join(__dirname, 'backend-dist');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const target = `${context.electronPlatformName}-${arch}`;
    if (
      manifest.protocol !== 1 ||
      manifest.bun !== '1.4.4' ||
      manifest.coreVersion !== KIMI_CORE_VERSION ||
      manifest.target !== target
    ) {
      throw new Error(
        `Desktop backend resources do not match ${target}, Bun 1.4.4 and core ${KIMI_CORE_VERSION}; rebuild on the target platform`,
      );
    }
    const binary = `kimi-desktop-backend${context.electronPlatformName === 'win32' ? '.exe' : ''}`;
    for (const file of [binary, 'search-worker.mjs', 'text-build-worker.mjs']) {
      const digest = createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex');
      if (manifest.files?.[file] !== digest)
        throw new Error(
          `Desktop backend resource ${file} is missing or stale; run bun run build:backend`,
        );
    }
    try {
      const electronRoot = path.dirname(require.resolve('electron/package.json'));
      const executableName = fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim();
      const executable = path.resolve(
        process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, 'dist'),
        executableName,
      );
      if (executableName === '' || !fs.statSync(executable).isFile())
        throw new Error('Electron executable is not installed');
      execFileSync(
        executable,
        [
          '-e',
          `if (process.arch !== ${JSON.stringify(arch)}) throw new Error('Electron architecture mismatch'); require('node-pty');`,
        ],
        {
          cwd: __dirname,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: 'pipe',
          windowsHide: true,
          timeout: 30_000,
        },
      );
    } catch {
      throw new Error(
        'node-pty did not load in the matching Electron runtime; run bun scripts/rebuild-native.mjs before packaging',
      );
    }
  },

  afterPack: async (context) => {
    await embedTahoeIconCatalog(context);
    patchCanaryUpdateConfig(context);
    injectLinuxMetainfo(context);
  },

  protocols:
    canary || preview ? [] : [{ name: 'Kimi Code', role: 'Viewer', schemes: ['kimi-code'] }],

  directories: {
    output: 'dist-app',
  },

  npmRebuild: false,
  asar: true,
  electronFuses: {
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  },
  asarUnpack: ['node_modules/node-pty/**'],

  files: ['out/**', 'package.json'],

  publish: preview
    ? null
    : [
        {
          provider: 'generic',
          url: 'https://code.kimi.com/kimi-code/desktop/',
          channel: canary ? 'canary' : 'latest',
        },
      ],

  extraResources: [
    { from: 'desktop-dist', to: 'desktop-dist' },
    {
      from: 'backend-dist',
      to: 'bun-backend',
      filter: ['kimi-desktop-backend', 'kimi-desktop-backend.exe', '*-worker.mjs', 'manifest.json'],
    },
    {
      from: path.resolve(path.dirname(require.resolve('fabric')), '../LICENSE'),
      to: 'third-party-notices/fabric-LICENSE.txt',
    },
    {
      from: 'native/screenshot-window-list/dist',
      to: 'screenshot-window-list',
      filter: ['screenshot-window-list', '*.exe', '*.node'],
    },
    { from: 'native/clamshell-tool/dist', to: 'clamshell-tool', filter: ['clamshell-tool'] },
    { from: 'build/lproj/', to: '.' },
    { from: 'build/', to: 'build/', filter: ['tray*'] },
  ],

  mac: {
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '13.0.0',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    ...(iconChannel ? { icon: `build/icon-${iconChannel}.icns` } : {}),
    extraResources: iconChannel
      ? [
          { from: `build/icon-${iconChannel}.png`, to: 'build/icon.png' },
          { from: `build/icon-${iconChannel}-dark.png`, to: 'build/icon-dark.png' },
        ]
      : [{ from: 'build/', to: 'build/', filter: ['icon.png', 'icon-dark.png'] }],
    target: ['dmg', 'zip'],
    artifactName,
    notarize,
    extendInfo: {
      NSDesktopFolderUsageDescription:
        'Kimi Code only accesses files in your Desktop folder when you open a project located there.',
      NSDocumentsFolderUsageDescription:
        'Kimi Code only accesses files in your Documents folder when you open a project located there.',
      NSDownloadsFolderUsageDescription:
        'Kimi Code only accesses files in your Downloads folder when you open a project located there.',
      NSCameraUsageDescription:
        'Kimi Code only accesses your camera when you allow a website in the built-in browser to use it.',
      NSMicrophoneUsageDescription:
        'Kimi Code only accesses your microphone when you allow a website in the built-in browser to use it.',
      NSLocationUsageDescription:
        'Kimi Code only accesses your location when you allow a website in the built-in browser to use it.',
    },
  },

  win: {
    target: ['nsis'],
    artifactName,
    ...(iconChannel ? { icon: `build/icon-${iconChannel}.ico` } : {}),
    extraResources: [
      {
        from: iconChannel ? `build/icon-${iconChannel}.ico` : 'build/icon.ico',
        to: 'build/icon.ico',
      },
    ],
    ...(azureTrustedSigning
      ? {
          azureSignOptions: {
            endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
            certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
            publisherName: 'NOVASCENT PRIVATE LIMITED',
          },
        }
      : {}),
  },

  nsis: {
    include: canary || preview ? 'build/installer.nsh' : 'build/installer-stable.nsh',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  extraMetadata: { desktopName: canary ? 'kimi-code-canary.desktop' : 'kimi-code.desktop' },

  linux: {
    syncDesktopName: true,
    category: 'Development',
    target: ['AppImage', 'deb', 'rpm'],
    artifactName,
    maintainer: 'Moonshot AI',
    executableName: canary ? 'kimi-code-canary' : 'kimi-code',
    ...(canary ? { icon: 'build/icon-canary.png' } : {}),
    description: 'Kimi Code Desktop - Everything you love about Kimi Code, now on desktop',
  },

  deb: {
    ...(canary ? { packageName: 'kimi-code-canary' } : {}),
    fpm: [
      `${path.join(__dirname, 'dist-app', 'linux-metainfo', LINUX_METAINFO_NAME)}=/usr/share/metainfo/${LINUX_METAINFO_NAME}`,
    ],
  },

  rpm: {
    ...(canary ? { packageName: 'kimi-code-canary' } : {}),
    fpm: [
      `${path.join(__dirname, 'dist-app', 'linux-metainfo', LINUX_METAINFO_NAME)}=/usr/share/metainfo/${LINUX_METAINFO_NAME}`,
    ],
  },
};
