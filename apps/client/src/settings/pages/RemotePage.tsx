import { DEFAULT_REMOTE, useSettingsStore } from "../settings.store";
import { Dropdown } from "../../ui/Dropdown";
import type { DropdownOption } from "../../ui/floating-menu.utils";
import { SESSION_MACHINE_TYPES } from "../../../../../libs/domain/src/session/session-machine-type.types.ts";
import { GithubTokenRow } from "../GithubTokenRow";
import { RemoteSecretsBlock } from "../RemoteSecretsBlock";
import { FORM_INPUT, PageHeader, TextRow } from "../SettingsFields";

/** The instance template's machine type first, then every machine type the gateway accepts for new session VMs. */
const MACHINE_TYPE_OPTIONS: DropdownOption[] = [
  { id: "", name: "Template default" },
  ...SESSION_MACHINE_TYPES.map((type) => ({
    id: type.name,
    name: type.name,
    description: `${type.cores} cores · ${type.memoryGb} GB · €${type.eurPerHour.toFixed(2)} per hour`,
  })),
];

/**
 * Where remote sessions run and how their previews are reached, the machine type of new session VMs, the GitHub token
 * and the remote secrets the gateway puts on every session VM (see src-tauri/src/remote).
 */
export function RemotePage() {
  const remote = useSettingsStore((state) => state.remote);
  const setRemote = useSettingsStore((state) => state.setRemote);
  const isDefault = JSON.stringify(remote) === JSON.stringify(DEFAULT_REMOTE);

  return (
    <section>
      <PageHeader title="Remote VM" hint="Where a session runs once you hand it off" isDefault={isDefault} onReset={() => setRemote(DEFAULT_REMOTE)} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <TextRow label="Google Cloud project" value={remote.project} onChange={(project) => setRemote({ project })} isMonospace />
          <p className="text-[13px] leading-snug text-neutral-500">
            Hunt finds the gateway, the VM of this project labelled hunt-role=gateway, with your gcloud login. It runs all the time and creates, starts
            and deletes a VM of its own for each session you hand off, vm-hunt-s-&lt;id&gt;, and routes the previews of its preview domain to them:
            https://&lt;id&gt;-&lt;port&gt;.&lt;domain&gt; behind your Google login, starting a VM that is off, and https://&lt;id&gt;-&lt;port&gt;-open.&lt;domain&gt;
            without it for the services the repository's hunt.json marks public, protected only by the app's own login. Hunt reaches the gateway and the session VMs
            over SSH through an IAP tunnel. The infrastructure repository configures the gateway, the session VMs' instance template and the gateway's
            poller for GitHub issues labelled swf. The chat header offers the handoff once the project is set.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-sm text-neutral-100">Machine type</div>
            <Dropdown
              title="Machine type of the session VMs the gateway creates"
              value={remote.machineType}
              options={MACHINE_TYPE_OPTIONS}
              onChange={(machineType) => setRemote({ machineType })}
              className={`${FORM_INPUT} flex items-center justify-between gap-1.5 text-left font-mono`}
            />
            {/* Keeps the field aligned with the unit column of NumberRow. */}
            <span className="w-6" />
          </div>
          <p className="text-[13px] leading-snug text-neutral-500">
            Applies to the session VMs the gateway creates from now on; a session keeps the VM it has. The template default is the machine type of the
            infrastructure's instance template. Prices are on-demand list prices per running hour; a session VM stops itself when idle.
          </p>
        </div>
        <GithubTokenRow />
        <RemoteSecretsBlock />
      </div>
    </section>
  );
}
