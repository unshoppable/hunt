import { useState } from "react";
import { appVersion, checkForUpdate, installUpdate, relaunchApp, type Update } from "../../ipc/updater.utils";
import { PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { useLoad } from "../../ui/load.hook";
import { errorText } from "../../ui/error-text.utils";
import { NO_PROGRESS, applyDownloadEvent, describeProgress, downloadFraction, type DownloadProgress } from "../update-progress.utils";
import { PageHeader } from "../SettingsFields";
import { CliInstallBlock } from "../CliInstallBlock";

/** What one update check and the install that may follow are at: the phases follow each other in this order. */
type UpdateState =
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; update: Update }
  | { phase: "downloading"; update: Update; progress: DownloadProgress }
  | { phase: "installed"; update: Update }
  | { phase: "error"; message: string };

/**
 * The running version and whether the release feed has a newer one; checks once when the page opens. An update is
 * downloaded and installed here and takes effect when Hunt restarts, from the button or the next launch. Below, the
 * `hunt` command line tool is installed on the PATH.
 */
export function UpdatesPage() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ phase: "checking" });
  const [checkCount, setCheckCount] = useState(0);

  useLoad(appVersion, { onValue: setVersion, onError: () => setVersion(null) }, []);
  useLoad(
    checkForUpdate,
    {
      onValue: (update) => setState(update ? { phase: "available", update } : { phase: "current" }),
      onError: (reason) => setState({ phase: "error", message: errorText(reason) }),
    },
    [checkCount],
  );

  const checkAgain = () => {
    setState({ phase: "checking" });
    setCheckCount((count) => count + 1);
  };
  const install = async (update: Update) => {
    setState({ phase: "downloading", update, progress: NO_PROGRESS });
    try {
      await installUpdate(update, (event) => {
        setState((current) => (current.phase === "downloading" ? { ...current, progress: applyDownloadEvent(current.progress, event) } : current));
      });
      setState({ phase: "installed", update });
    } catch (reason) {
      setState({ phase: "error", message: errorText(reason) });
    }
  };
  const relaunch = () => void relaunchApp().catch((reason: unknown) => setState({ phase: "error", message: errorText(reason) }));

  const status =
    state.phase === "checking" ? "Checking for updates…"
    : state.phase === "current" ? "Hunt is up to date."
    : state.phase === "available" ? `Hunt ${state.update.version} is available.`
    : state.phase === "downloading" ? `Downloading Hunt ${state.update.version}…`
    : state.phase === "installed" ? `Hunt ${state.update.version} is installed and starts with the next launch.`
    : "Could not check for updates.";
  const notes = state.phase === "available" || state.phase === "downloading" || state.phase === "installed" ? state.update.body?.trim() : undefined;

  return (
    <section>
      <PageHeader title="Updates" hint={version ? `Hunt ${version}` : "Hunt"} isDefault onReset={() => undefined} />
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-sm text-neutral-100">{status}</div>
          {state.phase === "available" ? (
            <button type="button" onClick={() => void install(state.update)} className={`${PRIMARY_BUTTON_XS} shrink-0`}>
              Download and install
            </button>
          ) : state.phase === "installed" ? (
            <button type="button" onClick={relaunch} className={`${PRIMARY_BUTTON_XS} shrink-0`}>
              Restart now
            </button>
          ) : (
            <button type="button" onClick={checkAgain} disabled={state.phase === "checking" || state.phase === "downloading"} className={`${SECONDARY_BUTTON_XS} shrink-0`}>
              {state.phase === "error" ? "Try again" : "Check again"}
            </button>
          )}
        </div>
        {state.phase === "downloading" ? <DownloadProgressBar progress={state.progress} /> : null}
        {state.phase === "error" ? <p className="text-[13px] leading-snug break-words text-red-300">{state.message}</p> : null}
        {notes ? (
          <div className="rounded-md border border-(--line) bg-(--surface-inset) px-3 py-2">
            <h4 className="text-[12px] font-medium tracking-wide text-neutral-500 uppercase">What's new</h4>
            <p className="mt-1 text-[13px] leading-snug whitespace-pre-wrap text-neutral-300">{notes}</p>
          </div>
        ) : null}
        <p className="text-[13px] leading-snug text-neutral-500">Updates come from the GitHub releases of unshoppable/hunt. The download replaces the app in place; the new version runs once Hunt restarts.</p>
      </div>
      <div className="mt-6">
        <CliInstallBlock />
      </div>
    </section>
  );
}

/** Progress of an update download; pulses at full width while the total size is unknown. */
function DownloadProgressBar({ progress }: { progress: DownloadProgress }) {
  const fraction = downloadFraction(progress);
  return (
    <div className="flex flex-col gap-1">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} className="h-1.5 overflow-hidden rounded-full bg-white/8">
        <div className={`h-full rounded-full bg-blue-500 transition-[width] ${fraction === null ? "w-full animate-pulse" : ""}`} style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </div>
      <span className="text-[12px] text-neutral-500">{describeProgress(progress)}</span>
    </div>
  );
}
