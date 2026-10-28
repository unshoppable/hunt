import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenTo } from "../ipc/events";
import { appVersion } from "../ipc/updater.utils";
import { DEFAULT_AI_LANGUAGE, useSettingsStore, type PaneKey } from "./settings.store";
import { HEADER_BAR } from "../ui/bars.constants";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../ui/buttons.constants";
import { useSecondaryWindow } from "../ui/secondary-window.hook";
import { useLoad } from "../ui/load.hook";
import { type SettingsPage } from "./settings-window.utils";
import { SECTIONS } from "./pane-sections.data";
import { PaneSettingsPage } from "./pages/PaneSettingsPage";
import { AgentPage } from "./pages/AgentPage";
import { SessionsPage } from "./pages/SessionsPage";
import { PopupsPage } from "./pages/PopupsPage";
import { RemotePage } from "./pages/RemotePage";
import { FileIconsPage } from "./pages/FileIconsPage";
import { FolderIconsPage } from "./pages/FolderIconsPage";
import { KeymapPage } from "./pages/KeymapPage";
import { UpdatesPage } from "./pages/UpdatesPage";

/**
 * The pages that are not a pane: what Hunt asks the agent for on its own, how sessions are deleted, which icon a
 * file or folder gets, the keyboard shortcuts and whether a newer Hunt exists.
 */
const AGENT_PAGE = "agent";
const SESSIONS_PAGE = "sessions";
const POPUPS_PAGE = "popups";
const REMOTE_PAGE = "remote";
const FILE_ICONS_PAGE = "fileIcons";
const FOLDER_ICONS_PAGE = "folderIcons";
const KEYMAP_PAGE = "keymap";
const UPDATES_PAGE: SettingsPage = "updates";
type Page = PaneKey | typeof AGENT_PAGE | typeof SESSIONS_PAGE | typeof POPUPS_PAGE | typeof REMOTE_PAGE | typeof FILE_ICONS_PAGE | typeof FOLDER_ICONS_PAGE | typeof KEYMAP_PAGE | SettingsPage;

/** Whether the window was booted ahead of time (`?warm=1`) and stays hidden until the main window shows it. */
const isWarm = new URLSearchParams(window.location.search).has("warm");

/** The page another window asked for in the URL hash (see settings-window.utils.ts), else the first one. */
function initialPage(): Page {
  return window.location.hash === `#${UPDATES_PAGE}` ? UPDATES_PAGE : NAV_GROUPS[0].pages[0].key;
}

/** The navigation sidebar: small group headings, one entry per page. */
const NAV_GROUPS: { title: string; pages: { key: Page; title: string }[] }[] = [
  {
    title: "General",
    pages: [
      { key: AGENT_PAGE, title: "Agent" },
      { key: SESSIONS_PAGE, title: "Sessions" },
      { key: POPUPS_PAGE, title: "Popups" },
      { key: REMOTE_PAGE, title: "Remote VM" },
      { key: FILE_ICONS_PAGE, title: "File icons" },
      { key: FOLDER_ICONS_PAGE, title: "Folder icons" },
      { key: KEYMAP_PAGE, title: "Keymap" },
      { key: UPDATES_PAGE, title: "Updates" },
    ],
  },
  { title: "Panes", pages: SECTIONS.map((section) => ({ key: section.pane, title: section.title })) },
];

/**
 * The settings as a window of their own (see settings-window.utils.ts), opened from the sidebar's gear button or ⌘,. It
 * boots hidden, usually ahead of time, and shows once rendered or, when booted ahead, once the main window shows it; the
 * traffic light, Escape, ⌘W and "Done" only hide it so the next open is instant. Every window keeps its own
 * copy of the settings store, so changes made here reach the others through `useSettingsSync`.
 */
export function SettingsWindow() {
  const resetPanes = useSettingsStore((state) => state.resetPanes);
  const setAiLanguage = useSettingsStore((state) => state.setAiLanguage);
  const resetIconRules = useSettingsStore((state) => state.resetIconRules);
  const resetFolderIconRules = useSettingsStore((state) => state.resetFolderIconRules);
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);
  const resetDetachedPopups = useSettingsStore((state) => state.resetDetachedPopups);
  const resetKeymap = useSettingsStore((state) => state.resetKeymap);
  const [activePage, setActivePage] = useState<Page>(initialPage);
  const [version, setVersion] = useState<string | null>(null);
  const activeSection = SECTIONS.find((section) => section.pane === activePage);
  const resetAll = () => {
    resetPanes();
    setAiLanguage(DEFAULT_AI_LANGUAGE);
    resetIconRules();
    resetFolderIconRules();
    setConfirmSessionDelete(true);
    resetDetachedPopups();
    resetKeymap();
  };

  useSecondaryWindow("settings", closeWindow, { isReady: !isWarm });
  useLoad(appVersion, { onValue: setVersion, onError: () => setVersion(null) }, []);

  useEffect(() => {
    const subscription = listenTo("settings:show-page", ({ page }) => setActivePage(page), { target: getCurrentWindow().label });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);

  return (
    <div className="flex h-full flex-col bg-(--surface-chat)">
      {/* The macOS traffic lights sit in this row (see openSettingsWindow.ts), so it starts further right and drags the window. */}
      <div data-tauri-drag-region="" className={`${HEADER_BAR} gap-2 border-b border-(--line) pr-3 pl-23 text-sm`}>
        <span data-tauri-drag-region="" className="font-semibold tracking-wide text-neutral-300">Settings</span>
        {version ? (
          <span data-tauri-drag-region="" className="text-[12px] text-neutral-500 tabular-nums">
            {`v${version}`}
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings pages" className="flex w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r border-(--line) bg-(--surface-inset) p-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5">
              <h3 className="px-2 pb-1 text-[12px] font-medium tracking-wide text-neutral-500 uppercase">{group.title}</h3>
              {group.pages.map((page) => (
                <NavItem key={page.key} title={page.title} active={page.key === activePage} onSelect={() => setActivePage(page.key)} />
              ))}
            </div>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {activeSection ? (
            <PaneSettingsPage key={activeSection.pane} {...activeSection} />
          ) : activePage === SESSIONS_PAGE ? (
            <SessionsPage />
          ) : activePage === POPUPS_PAGE ? (
            <PopupsPage />
          ) : activePage === REMOTE_PAGE ? (
            <RemotePage />
          ) : activePage === FILE_ICONS_PAGE ? (
            <FileIconsPage />
          ) : activePage === FOLDER_ICONS_PAGE ? (
            <FolderIconsPage />
          ) : activePage === KEYMAP_PAGE ? (
            <KeymapPage />
          ) : activePage === UPDATES_PAGE ? (
            <UpdatesPage />
          ) : (
            <AgentPage />
          )}
        </div>
      </div>

      <div className="flex justify-between border-t border-(--line) px-4 py-3">
        <button type="button" onClick={resetAll} className={GHOST_BUTTON_MD}>
          Reset all to defaults
        </button>
        <button type="button" onClick={() => void closeWindow()} className={PRIMARY_BUTTON_MD}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Hides the window; a focused text field commits its value first (they save on blur). */
async function closeWindow(): Promise<void> {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  await getCurrentWindow().hide();
}

/** A sidebar entry selecting one settings page. */
function NavItem({ title, active, onSelect }: { title: string; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={`truncate rounded px-2 py-1.5 text-left text-sm ${
        active ? "bg-(--row-selected) text-neutral-100" : "text-neutral-400 hover:bg-(--row-hover) hover:text-neutral-200"
      }`}
    >
      {title}
    </button>
  );
}
