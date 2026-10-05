import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState, useEffect, useCallback } from 'react';
import type { ProjectFile } from 'shared/types';

import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { bridge } from '@/services';
import { MEDIA_CONFIG } from '@/services/config';
import { useChatStore } from '@/stores';

export type FilePickerMode = 'search' | 'folder';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  matchPositions?: number[];
}

interface ActiveToken {
  trigger: '/' | '@';
  start: number;
  query: string;
}

const NO_FILES: ProjectFile[] = [];

interface UseFilePickerResult {
  showFileMenu: boolean;
  fileItems: FileItem[];
  selectedIndex: number;
  isLoading: boolean;
  isStale: boolean;
  showMediaOption: boolean;
  fileMenuHeaderCount: number;
  filePickerMode: FilePickerMode;
  folderPath: string;
  setSelectedIndex: (index: number) => void;
  handleSelectItem: (item: FileItem | undefined) => void;
  handleFileMenuKey: (e: React.KeyboardEvent) => boolean;
  handleBrowseInto: (item: FileItem) => void;
  handleBrowseUp: () => void;
  handleBrowseToSearch: () => void;
  handleBrowseToFolder: () => void;
  resetFilePicker: () => void;
}

export function useFilePicker(
  activeToken: ActiveToken | null,
  onInsertFile: (path: string) => void,
  onPickMedia: () => void,
  onCancel: () => void,
): UseFilePickerResult {
  const { isStreaming, draftMedia } = useChatStore();
  const canAddMedia = !isStreaming && draftMedia.length < MEDIA_CONFIG.maxCount;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filePickerMode, setFilePickerMode] = useState<FilePickerMode>('search');
  const [folderPath, setFolderPath] = useState('');

  const showFileMenu = activeToken?.trigger === '@';
  const query = activeToken?.query || '';

  const debouncedQuery = useDebouncedValue(query, 100);
  const searchQuery = useQuery({
    queryKey: ['projectFiles', 'search', debouncedQuery],
    queryFn: () => bridge.getProjectFiles({ query: debouncedQuery || undefined }),
    enabled: showFileMenu && filePickerMode === 'search',
    placeholderData: keepPreviousData,
  });
  const searchResults = searchQuery.data ?? NO_FILES;
  const isSearchLoading = searchQuery.isLoading;

  const folderQuery = useQuery({
    queryKey: ['projectFiles', 'folder', folderPath || '.'],
    queryFn: () => bridge.getProjectFiles({ directory: folderPath || '.' }),
    enabled: showFileMenu && filePickerMode === 'folder',
  });
  const folderItems = folderQuery.data ?? NO_FILES;
  const isFolderLoading = folderQuery.isLoading;

  const isStale =
    filePickerMode === 'search' && (debouncedQuery !== query || searchQuery.isPlaceholderData);

  useEffect(() => {
    if (!showFileMenu) {
      setFilePickerMode('search');
      setFolderPath('');
    }
  }, [showFileMenu]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const fileItems = useMemo((): FileItem[] => {
    if (filePickerMode === 'folder') {
      return folderItems.map((f) => ({
        name: f.name,
        path: f.path,
        isDirectory: f.isDirectory,
        matchPositions: f.matchPositions,
      }));
    }
    return searchResults.slice(0, 50).map((f) => ({
      name: f.name,
      path: f.path,
      isDirectory: f.isDirectory,
      matchPositions: f.matchPositions,
    }));
  }, [filePickerMode, folderItems, searchResults]);

  const isLoading = filePickerMode === 'search' ? isSearchLoading : isFolderLoading;
  const showMediaOption = filePickerMode === 'search' && canAddMedia && query === '';
  const fileMenuHeaderCount =
    filePickerMode === 'search' ? (showMediaOption ? 2 : 1) : folderPath ? 2 : 1;

  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, fileMenuHeaderCount + fileItems.length - 1)));
  }, [fileMenuHeaderCount, fileItems.length]);

  const resetFilePicker = useCallback(() => {
    setSelectedIndex(0);
    setFilePickerMode('search');
    setFolderPath('');
  }, []);

  const handleSelectItem = useCallback(
    (item: FileItem | undefined) => {
      if (isStale) return;
      if (!item) return;
      onInsertFile(item.path);
    },
    [isStale, onInsertFile],
  );

  const handleBrowseInto = useCallback((item: FileItem) => {
    setFilePickerMode('folder');
    setFolderPath(item.path);
    setSelectedIndex(0);
  }, []);

  const handleBrowseUp = useCallback(() => {
    setFolderPath((path) => path.split('/').slice(0, -1).join('/'));
    setSelectedIndex(0);
  }, []);

  const handleBrowseToSearch = useCallback(() => {
    setFilePickerMode('search');
    setFolderPath('');
    setSelectedIndex(0);
  }, []);

  const handleBrowseToFolder = useCallback(() => {
    setFilePickerMode('folder');
    setFolderPath('');
    setSelectedIndex(0);
  }, []);

  const handleFileMenuConfirm = useCallback(() => {
    // Results for the current query are not in yet: ignore the confirmation
    // entirely, including the header rows.
    if (isStale) return;

    if (filePickerMode === 'search') {
      if (showMediaOption && selectedIndex === 0) {
        onPickMedia();
        return;
      }

      const browseIndex = showMediaOption ? 1 : 0;
      if (selectedIndex === browseIndex) {
        handleBrowseToFolder();
        return;
      }
    }

    if (filePickerMode === 'folder' && selectedIndex === 0) {
      handleBrowseToSearch();
      return;
    }

    if (filePickerMode === 'folder' && selectedIndex === 1 && folderPath) {
      handleBrowseUp();
      return;
    }

    const item = fileItems[selectedIndex - fileMenuHeaderCount];
    if (!item) return;

    if (filePickerMode === 'search' && item.isDirectory) {
      handleBrowseInto(item);
    } else {
      onInsertFile(item.path);
    }
  }, [
    filePickerMode,
    folderPath,
    selectedIndex,
    showMediaOption,
    isStale,
    fileMenuHeaderCount,
    fileItems,
    onPickMedia,
    onInsertFile,
    handleBrowseToFolder,
    handleBrowseToSearch,
    handleBrowseUp,
    handleBrowseInto,
  ]);

  const handleFileMenuKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showFileMenu) return false;

      const maxIdx = Math.max(0, fileMenuHeaderCount + fileItems.length - 1);

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, maxIdx));
          return true;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return true;
        case 'ArrowLeft':
          if (filePickerMode !== 'folder') return false;
          e.preventDefault();
          if (folderPath) {
            handleBrowseUp();
          } else {
            handleBrowseToSearch();
          }
          return true;
        case 'ArrowRight': {
          if (filePickerMode !== 'folder') return false;
          const itemForRight = fileItems[selectedIndex - fileMenuHeaderCount];
          if (!itemForRight?.isDirectory) return false;
          e.preventDefault();
          handleBrowseInto(itemForRight);
          return true;
        }
        case 'Tab':
        case 'Enter':
          if (fileMenuHeaderCount + fileItems.length === 0) return false;
          e.preventDefault();
          handleFileMenuConfirm();
          return true;
        case 'Escape':
          e.preventDefault();
          if (filePickerMode === 'folder') {
            handleBrowseToSearch();
            return true;
          }
          onCancel();
          return true;
        default:
          return false;
      }
    },
    [
      showFileMenu,
      fileMenuHeaderCount,
      fileItems,
      filePickerMode,
      folderPath,
      selectedIndex,
      handleFileMenuConfirm,
      handleBrowseUp,
      handleBrowseToSearch,
      handleBrowseInto,
      onCancel,
    ],
  );

  return {
    showFileMenu,
    fileItems,
    selectedIndex,
    isLoading,
    isStale,
    showMediaOption,
    fileMenuHeaderCount,
    filePickerMode,
    folderPath,
    setSelectedIndex,
    handleSelectItem,
    handleFileMenuKey,
    handleBrowseInto,
    handleBrowseUp,
    handleBrowseToSearch,
    handleBrowseToFolder,
    resetFilePicker,
  };
}
