import { useState } from "react";
import { commands } from "../ipc/commands";
import type { CliInstall } from "./settings.types";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";

const CODE = "font-mono text-neutral-400";

/**
 * The `hunt` command line tool: links `~/.local/bin/hunt` to the `hunt-cli` beside the app binary and says whether a
 * shell finds it. Hunt's PATH is the login shell's at launch, so a PATH change in ~/.zshrc shows here after a restart.
 */
export function CliInstallBlock() {
  const [install, setInstall] = useState<CliInstall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  useLoad(commands.cliInstallStatus, { onValue: setInstall, onError: (reason) => setError(errorText(reason)) }, []);

  async function installTool() {
    setIsInstalling(true);
    try {
      setInstall(await commands.installCli());
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setIsInstalling(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-[12px] font-medium tracking-wide text-neutral-500 uppercase">Command line</h4>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm break-words text-neutral-100">
          {install ? (
            <>
              <code className="font-mono">hunt</code> {install.installed ? `is installed at ${install.linkPath}.` : "is not installed."}
            </>
          ) : error ? (
            "Could not check the command line tool."
          ) : (
            "Checking the command line tool…"
          )}
        </div>
        <button type="button" onClick={() => void installTool()} disabled={isInstalling} className={`${SECONDARY_BUTTON_XS} shrink-0`}>
          {install?.installed ? "Reinstall" : "Install command line tool"}
        </button>
      </div>
      {error ? <p className="text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
      {install && !install.onPath ? (
        <p className="text-[13px] leading-snug text-neutral-300">
          <code className={CODE}>~/.local/bin</code> is not on your PATH, so a shell does not find <code className={CODE}>hunt</code> there. Add{" "}
          <code className={CODE}>{'export PATH="$HOME/.local/bin:$PATH"'}</code> to ~/.zshrc and open a new terminal; Hunt sees the change after a restart.
        </p>
      ) : null}
      <p className="text-[13px] leading-snug text-neutral-500">
        Links <code className={CODE}>~/.local/bin/hunt</code> to the hunt-cli inside this Hunt and replaces an earlier link; a file or folder of that name stays
        untouched. Updates keep the link working; install again after moving Hunt.
      </p>
    </div>
  );
}
