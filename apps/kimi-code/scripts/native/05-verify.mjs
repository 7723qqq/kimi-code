import { readFile } from 'node:fs/promises';

import { sha256 } from './04-sign.mjs';
import { run } from './exec.mjs';
import { nativeBinPath, targetTriple } from './paths.mjs';

async function verifyChecksum(executable) {
  const checksumPath = `${executable}.sha256`;
  let recorded;
  try {
    recorded = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
  } catch {
    throw new Error(`Checksum file not found: ${checksumPath}. Run the sign step first.`);
  }
  const actual = await sha256(executable);
  if (recorded !== actual) {
    throw new Error(`Checksum mismatch for ${executable}: ${actual} !== ${recorded}`);
  }
  console.log(`Checksum ok: ${executable}`);
}

export async function runVerifyStep({ requireGatekeeper = false } = {}) {
  const target = targetTriple();
  const executable = nativeBinPath(target);

  // The sign step writes <binary>.sha256 on every platform; verifying it here
  // is the only post-build integrity check non-macOS targets get. Notarization
  // does not modify the binary, so this stays valid after macOS signing.
  await verifyChecksum(executable);

  if (process.platform !== 'darwin') {
    console.log('Verify step skipped (not macOS)');
    return;
  }

  console.log(`==> codesign -dv ${executable}`);
  await run('codesign', ['-dv', '--verbose=2', executable]);

  if (requireGatekeeper) {
    // Opt-in Gatekeeper simulation — the pipeline always passes
    // requireGatekeeper:false because ad-hoc signed binaries fail spctl. The
    // real release gate is .github/actions/macos-notarize. Note `-t install`
    // assesses installer packages; bare executables want the execute policy
    // (-t execute).
    console.log(`==> spctl -a -vvv -t install ${executable}`);
    await run('spctl', ['-a', '-vvv', '-t', 'install', executable]);
  } else {
    console.log('Skipping spctl check (requireGatekeeper=false)');
  }
}
