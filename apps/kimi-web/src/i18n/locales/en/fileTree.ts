// Workspace file browser (components/WorkspaceFileBrowser.vue).
export default {
  title: 'Files',
  workspace: 'Workspace',
  refresh: 'Refresh',
  loading: 'Loading…',
  empty: 'No files',
  loadFailed: 'Failed to list directory',
  openFailed: 'Failed to open file',
  truncated: 'Truncated — showing the first {shown} of {total} bytes',
  binary: 'Binary file — use Download to inspect it',
  download: 'Download',
  size: '{size} · {lines} lines',
  gitModified: 'Modified',
  gitAdded: 'Added',
  gitDeleted: 'Deleted',
  gitUntracked: 'Untracked',
  gitConflict: 'Conflict',
} as const;
