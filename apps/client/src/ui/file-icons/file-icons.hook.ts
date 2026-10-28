import { useMemo } from "react";
import { useSettingsStore } from "../../settings/settings.store";
import { folderIconStateUrl, resolveFileIcon, resolveFolderIcon, vendoredIconUrl } from "./file-icons.utils";

/**
 * Resolver from a worktree-relative file path (a bare file name works too) to its icon URL, bound to the icon rules
 * of the settings; the component re-renders when the rules change.
 */
export function useFileIconUrl(): (path: string) => string {
  const rules = useSettingsStore((state) => state.iconRules);
  return useMemo(() => {
    const cache = new Map<string, string>();
    return (path: string) => {
      const cached = cache.get(path);
      if (cached) return cached;
      const url = vendoredIconUrl(resolveFileIcon(path, rules));
      cache.set(path, url);
      return url;
    };
  }, [rules]);
}

/**
 * Resolver from a worktree-relative folder path (a bare folder name works too) to its icon URL, in the open state if
 * `isOpen`, bound to the folder icon rules of the settings; the component re-renders when the rules change.
 */
export function useFolderIconUrl(): (path: string, isOpen?: boolean) => string {
  const rules = useSettingsStore((state) => state.folderIconRules);
  return useMemo(() => (path: string, isOpen = false) => folderIconStateUrl(resolveFolderIcon(path, rules), isOpen), [rules]);
}
