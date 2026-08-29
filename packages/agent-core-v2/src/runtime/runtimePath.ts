import { posix as posixPath, win32 as win32Path } from 'node:path';

import type { RuntimePath } from './runtime';

const DRIVE_LETTER_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function toForwardSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * Builds the path shim for a runtime's path class.
 *
 * The posix shim additionally guards against host/runtime path-class skew —
 * a posix path class running inside a Windows host process (a test harness
 * faking a Linux environment, or a remote posix runtime driven from
 * Windows). There, a drive-letter path (`C:/...`) is not posix-absolute and
 * a naive resolve joins it onto the host process cwd (which Bun reports in
 * msys form, e.g. `/kimi/...`). Drive-letter paths are therefore treated as
 * absolute and delegated to the win32 implementation, normalized to forward
 * slashes. The win32 shim delegates directly with no rewriting.
 */
export function createRuntimePath(pathClass: 'posix' | 'win32'): RuntimePath {
  if (pathClass === 'win32') {
    return {
      separator: win32Path.sep as '\\' | '/',
      delimiter: win32Path.delimiter as ';' | ':',
      isAbsolute: (p) => win32Path.isAbsolute(p),
      join: (...paths) => win32Path.join(...paths),
      relative: (from, to) => win32Path.relative(from, to),
      resolve: (...paths) => win32Path.resolve(...paths),
      basename: (p) => win32Path.basename(p),
      dirname: (p) => win32Path.dirname(p),
    };
  }

  return {
    separator: posixPath.sep as '/' | '\\',
    delimiter: posixPath.delimiter as ':' | ';',
    isAbsolute: (p) => posixPath.isAbsolute(p) || DRIVE_LETTER_ABSOLUTE.test(p),
    join: (...paths) => posixPath.join(...paths),
    relative: (from, to) => {
      if (DRIVE_LETTER_ABSOLUTE.test(from) && DRIVE_LETTER_ABSOLUTE.test(to)) {
        return toForwardSlashes(win32Path.relative(from, to));
      }
      return posixPath.relative(from, to);
    },
    resolve: (...paths) => {
      const anchor = paths.findIndex((segment) => DRIVE_LETTER_ABSOLUTE.test(segment));
      if (anchor < 0) return posixPath.resolve(...paths);
      return toForwardSlashes(win32Path.resolve(...paths.slice(anchor)));
    },
    basename: (p) => posixPath.basename(p),
    dirname: (p) => posixPath.dirname(p),
  };
}
