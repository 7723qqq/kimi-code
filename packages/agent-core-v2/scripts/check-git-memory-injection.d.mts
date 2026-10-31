export interface GitMemoryImportViolation {
  file: string;
  specifier: string;
  label: string;
}

export function extractImportSpecifiers(source: string): string[];

export function findViolations(
  relPath: string,
  source: string,
): GitMemoryImportViolation[];
