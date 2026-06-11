/**
 * Pure XML builder for the Windows Task Scheduler task that supervises
 * `kimi server run`.
 *
 * Mirrors `../openclaw/src/daemon/schtasks.ts:buildScheduledTaskXml` but
 * drops the wrapper-script indirection (we point `<Command>` at the kimi
 * binary directly and put the argv in `<Arguments>`).
 *
 * The task XML must be UTF-16 LE with a BOM when handed to
 * `schtasks /Create /XML`. The encoding is applied by `writeTaskXmlFile`
 * in `schtasks.ts`; this module is only string-level.
 */

const escapeXmlText = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export interface BuildScheduledTaskXmlInput {
  description: string;
  /** Absolute path of the binary to run. Becomes `<Command>`. */
  command: string;
  /**
   * Argv to pass to the command, already-quoted as one string.
   * Becomes `<Arguments>`. Caller is responsible for quoting paths with spaces.
   */
  arguments?: string;
  /** Optional user under which the task runs (e.g. `DOMAIN\\user`). */
  taskUser?: string;
}

export function buildScheduledTaskXml(input: BuildScheduledTaskXmlInput): string {
  const description = escapeXmlText(input.description);
  const command = escapeXmlText(input.command);
  const args = input.arguments ? escapeXmlText(input.arguments) : '';

  const principalLogon = input.taskUser
    ? `\n      <UserId>${escapeXmlText(input.taskUser)}</UserId>\n      <LogonType>InteractiveToken</LogonType>`
    : '\n      <GroupId>S-1-5-32-545</GroupId>';
  const triggerUser = input.taskUser
    ? `\n      <UserId>${escapeXmlText(input.taskUser)}</UserId>`
    : '';
  const argumentsXml = args ? `\n      <Arguments>${args}</Arguments>` : '';

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${triggerUser}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalLogon}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>${argumentsXml}
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Parse the CSV output of `schtasks /Query /TN <name> /FO CSV /V`.
 *
 * Returns the first data row as a `{ header: value }` map, or undefined if
 * the task is missing. We use /V (verbose) so we get `Status` and `Last Result`
 * columns the lifecycle commands look at.
 */
export function parseSchtasksQuery(output: string): Record<string, string> | undefined {
  // schtasks emits CRLF line endings on Windows; split on \r?\n to be safe.
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return undefined;

  const header = parseCsvRow(lines[0] ?? '');
  const firstRow = parseCsvRow(lines[1] ?? '');
  if (header.length === 0 || firstRow.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (let i = 0; i < header.length; i += 1) {
    const key = header[i] ?? '';
    const value = firstRow[i] ?? '';
    if (key.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/** Minimal CSV row parser — handles `"value, with comma"` and `""` escapes. */
function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
    } else {
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        cells.push(current);
        current = '';
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
    }
  }
  cells.push(current);
  return cells;
}
