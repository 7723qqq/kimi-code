// 工作区文件浏览器（components/WorkspaceFileBrowser.vue）。
export default {
  title: '文件',
  workspace: '工作区',
  refresh: '刷新',
  loading: '加载中…',
  empty: '没有文件',
  loadFailed: '目录加载失败',
  openFailed: '文件打开失败',
  truncated: '已截断——仅显示前 {shown} / {total} 字节',
  binary: '二进制文件——请下载后查看',
  download: '下载',
  size: '{size} · {lines} 行',
  gitModified: '已修改',
  gitAdded: '已新增',
  gitDeleted: '已删除',
  gitUntracked: '未跟踪',
  gitConflict: '冲突',
} as const;
