import {
  IconFolder,
  IconFile,
  IconArrowLeft,
  IconFolderOpen,
  IconPhoto,
} from '@tabler/icons-react';
import { Fragment, useEffect, useRef } from 'react';

import { mentionMatchSpans, type MentionMatchSpan } from '@/lib/mention-match';
import { cn } from '@/lib/utils';

export type FilePickerMode = 'search' | 'folder';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  matchPositions?: number[];
}

interface FilePickerMenuProps {
  items: FileItem[];
  selectedIndex: number;
  isLoading?: boolean;
  isStale?: boolean;
  showMediaOption?: boolean;
  mode?: FilePickerMode;
  currentPath?: string;
  onSelectMedia?: () => void;
  onSelectItem: (item: FileItem) => void;
  onSwitchToFolder?: () => void;
  onSwitchToSearch?: () => void;
  onNavigateUp?: () => void;
  onNavigateInto?: (item: FileItem) => void;
  onHover: (index: number) => void;
}

function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const ellipsis = '…';
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
}

function parentDir(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

function nameSpans(item: FileItem): MentionMatchSpan[] {
  const path = item.path.endsWith('/') ? item.path.slice(0, -1) : item.path;
  return mentionMatchSpans(
    item.name,
    item.matchPositions,
    Math.max(0, path.length - item.name.length),
  );
}

function dirSpans(item: FileItem): MentionMatchSpan[] {
  return mentionMatchSpans(parentDir(item.path), item.matchPositions, 0);
}

function renderSpans(spans: MentionMatchSpan[], hitClassName: string) {
  return spans.map((span, spanIdx) =>
    span.hit ? (
      <span key={spanIdx} className={hitClassName}>
        {span.text}
      </span>
    ) : (
      <Fragment key={spanIdx}>{span.text}</Fragment>
    ),
  );
}

export function FilePickerMenu({
  items,
  selectedIndex,
  isLoading,
  isStale = false,
  showMediaOption = true,
  mode = 'search',
  currentPath = '',
  onSelectMedia,
  onSelectItem,
  onSwitchToFolder,
  onSwitchToSearch,
  onNavigateUp,
  onNavigateInto,
  onHover,
}: FilePickerMenuProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const hoverSelectionRef = useRef<number | null>(null);

  useEffect(() => {
    if (hoverSelectionRef.current === selectedIndex) {
      hoverSelectionRef.current = null;
      return;
    }
    hoverSelectionRef.current = null;
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const preventFocus = (e: React.MouseEvent) => e.preventDefault();

  const handleHover = (index: number) => {
    if (isStale) return;
    hoverSelectionRef.current = index;
    onHover(index);
  };

  // Header rows above the item list: search mode shows media/select + "browse
  // folders"; folder mode shows "back to search" + an optional ".." parent row.
  const getHeaderCount = () => {
    if (mode === 'search') {
      return showMediaOption ? 2 : 1;
    }
    return currentPath ? 2 : 1;
  };

  const headerCount = getHeaderCount();

  return (
    <div className="rounded-md border bg-popover shadow-md overflow-hidden">
      {mode === 'search' ? (
        <>
          {showMediaOption && onSelectMedia && (
            <button
              ref={selectedIndex === 0 ? selectedRef : null}
              onMouseDown={preventFocus}
              onClick={onSelectMedia}
              onMouseMove={() => handleHover(0)}
              className={cn(
                'w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border',
                selectedIndex === 0 ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <IconPhoto className="size-3.5 text-muted-foreground" />
              <span className="text-xs">Select images or videos…</span>
            </button>
          )}
          <button
            ref={selectedIndex === (showMediaOption ? 1 : 0) ? selectedRef : null}
            onMouseDown={preventFocus}
            onClick={onSwitchToFolder}
            onMouseMove={() => handleHover(showMediaOption ? 1 : 0)}
            className={cn(
              'w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border',
              selectedIndex === (showMediaOption ? 1 : 0) ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            <IconFolderOpen className="size-3.5 text-muted-foreground" />
            <span className="text-xs">Browse folders…</span>
          </button>
        </>
      ) : (
        <>
          <button
            ref={selectedIndex === 0 ? selectedRef : null}
            onMouseDown={preventFocus}
            onClick={onSwitchToSearch}
            onMouseMove={() => handleHover(0)}
            className={cn(
              'w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border',
              selectedIndex === 0 ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            <IconArrowLeft className="size-3.5 text-muted-foreground" />
            <span className="text-xs">Back to search</span>
          </button>
          {currentPath && (
            <button
              ref={selectedIndex === 1 ? selectedRef : null}
              onMouseDown={preventFocus}
              onClick={onNavigateUp}
              onMouseMove={() => handleHover(1)}
              className={cn(
                'w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border/50',
                selectedIndex === 1 ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <IconFolder className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">..</span>
              <span className="text-[10px] text-muted-foreground truncate">
                ({currentPath.split('/').pop()})
              </span>
            </button>
          )}
        </>
      )}
      <div className={cn('max-h-64 overflow-y-auto', isStale && 'opacity-60')}>
        {isLoading ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {mode === 'search' ? 'No files found' : 'Empty folder'}
          </div>
        ) : (
          items.map((item, idx) => {
            const itemIndex = idx + headerCount;
            const dir = parentDir(item.path);
            const isSearchMode = mode === 'search';
            return (
              <button
                key={item.path}
                ref={itemIndex === selectedIndex ? selectedRef : null}
                onMouseDown={preventFocus}
                onClick={() => {
                  if (isSearchMode && item.isDirectory) {
                    onNavigateInto?.(item);
                  } else {
                    onSelectItem(item);
                  }
                }}
                onMouseMove={() => handleHover(itemIndex)}
                className={cn(
                  'w-full px-2 py-1.5 text-left flex items-center justify-between gap-3',
                  itemIndex === selectedIndex ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs shrink-0">
                  {item.isDirectory ? (
                    <IconFolder className="size-3 text-muted-foreground" />
                  ) : (
                    <IconFile className="size-3 text-muted-foreground" />
                  )}
                  <span className={cn(item.isDirectory && 'font-medium')}>
                    {isSearchMode
                      ? renderSpans(nameSpans(item), 'text-foreground font-semibold')
                      : item.name}
                    {item.isDirectory && '/'}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  {isSearchMode ? (
                    dir && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-32">
                        {renderSpans(dirSpans(item), 'text-foreground')}
                      </span>
                    )
                  ) : (
                    <span className="text-[10px] text-muted-foreground truncate max-w-32">
                      {dir ? truncateMiddle(dir, 25) : ''}
                    </span>
                  )}
                  {item.isDirectory && !isSearchMode && (
                    <span className="text-[10px] text-muted-foreground">→</span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
