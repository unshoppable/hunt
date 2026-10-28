/** The section of the agent's prompt on a session VM that tells it how to run the repository's services. */
import type { ServiceConfig } from "./service-config.value-object.ts";
import type { SessionHost } from "./session-host.value-object.ts";

const NO_SERVICES_PROMPT = [
  "### The repository's services",
  "",
  "The repository has no hunt.json or declares no services in it: run the app as a developer would locally, in the tmux " +
    "session `app` as described above.",
].join("\n");

/**
 * The section of the agent's prompt that tells it how to run the services and lists each one with its port, URL and
 * who may open it; without services, it says so.
 */
export function servicesPrompt(services: readonly ServiceConfig[], host: SessionHost): string {
  if (services.length === 0) return NO_SERVICES_PROMPT;
  const rows = services.map((service) => {
    const access = service.guarded ? "Google login" : "public, app login only";
    return `| ${service.name} | ${service.port} | ${service.publicUrl(host)} | ${access} |`;
  });
  return [
    "### The repository's services",
    "",
    "Hunt runs the services of the repository's hunt.json on this VM, each as a systemd unit. Start only the services " +
      "your task needs; the repository's hunt.agent.md, when it has one, says which belong together:",
    "",
    "```",
    "sudo -n hunt-ctl service start <name>…",
    "```",
    "",
    "`restart`, `stop` and `status` take names the same way; `status` without names reports every service. A service " +
      "writes its output to `~/logs/<name>.log`. The variables hunt.json declares for a service apply to that service " +
      "only, not to your shell.",
    "",
    "| Service | Port | URL | Access |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
