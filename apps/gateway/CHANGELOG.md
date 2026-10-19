## 0.33.0 (2026-10-19)

### 🚀 Features

- **gateway:** the swf section of a repository's hunt.json sets the Claude model of the sessions the poller starts for its issues ("swf": {"model": "opus"}); without it Claude Code's default model applies ([33caaa4](https://github.com/unshoppable/hunt/commit/33caaa4))

### 🩹 Fixes

- **gateway:** swf.model in a repository's hunt.json takes only the full ID of a Claude model such as claude-opus-5-5; an alias such as opus is rejected, since its model changes with Claude Code's releases ([bcd7a09](https://github.com/unshoppable/hunt/commit/bcd7a09))

### 🧱 Updated Dependencies

- Updated session to 0.23.1

## 0.32.0 (2026-10-19)

### 🚀 Features

- **gateway:** a claimed swf issue moves to the "In Progress" column of every project it belongs to, next to its swf:running label; a project without that status or a missing app permission is only logged ([d67b371](https://github.com/unshoppable/hunt/commit/d67b371))

## 0.31.1 (2026-10-19)

### 🔥 Performance

- **gateway:** bring a VM up faster: the ready check puts the remote secrets in the same SSH command, and a finished start or resume operation reads the status without a pause ([dc54506](https://github.com/unshoppable/hunt/commit/dc54506))

## 0.31.0 (2026-10-18)

### 🚀 Features

- suspend idle session VMs instead of powering them off; a resume into a stockout stops and moves the VM ([#40](https://github.com/unshoppable/hunt/issues/40))

### 🧱 Updated Dependencies

- Updated session to 0.23.0

## 0.30.0 (2026-10-18)

### 🚀 Features

- transcripts of a remote session stream live both ways, and .hunt/sessions.md tells the agents of a worktree about one another ([d875510](https://github.com/unshoppable/hunt/commit/d875510))

### 🧱 Updated Dependencies

- Updated session to 0.22.0

## 0.29.0 (2026-10-18)

### 🚀 Features

- architecture tab with six diagram types, inline commit box and file filter in the changelist, queued prompts for every session, and swf answer delivery ([b78ef11](https://github.com/unshoppable/hunt/commit/b78ef11))

### 🧱 Updated Dependencies

- Updated session to 0.21.0

## 0.28.1 (2026-10-18)

### 🧱 Updated Dependencies

- Updated session to 0.20.1

## 0.28.0 (2026-10-18)

### 🧱 Updated Dependencies

- Updated session to 0.20.0

## 0.27.1 (2026-10-18)

### 🩹 Fixes

- **gateway:** let NTP through the metadata firewall, whose block let the gateway's clock drift ([01d8f1c](https://github.com/unshoppable/hunt/commit/01d8f1c))

### 🔥 Performance

- faster start of session VMs: operation waits, a 2 s readiness poll, the release check in the same call and an early connect of the desktop ([13c594e](https://github.com/unshoppable/hunt/commit/13c594e))

### 🧱 Updated Dependencies

- Updated session to 0.19.1

## 0.27.0 (2026-10-18)

### 🧱 Updated Dependencies

- Updated session to 0.19.0

## 0.26.0 (2026-10-17)

### 🚀 Features

- remote secrets for the services of session VMs, maintained in Hunt under Settings → Remote VM ([f2dd755](https://github.com/unshoppable/hunt/commit/f2dd755))

### 🧱 Updated Dependencies

- Updated session to 0.18.0

## 0.25.0 (2026-10-17)

### 🧱 Updated Dependencies

- Updated session to 0.17.0

## 0.24.0 (2026-10-17)

### 🧱 Updated Dependencies

- Updated session to 0.16.0

## 0.23.0 (2026-10-17)

### 🚀 Features

- act on GitHub as a GitHub App in poller sessions, with one-hour installation tokens the poller renews on running VMs (hunt-ctl github-token, gh wrapper, clone --git-name/--git-email) ([#36](https://github.com/unshoppable/hunt/issues/36))

### 🧱 Updated Dependencies

- Updated session to 0.15.0

## 0.22.0 (2026-10-17)

### 🚀 Features

- **gateway:** unpack the private files of a swf repository from the secret HUNT_SWF_FILES_<owner>_<repo> into the session's worktree ([31e9105](https://github.com/unshoppable/hunt/commit/31e9105))

## 0.21.0 (2026-10-17)

### 🧱 Updated Dependencies

- Updated session to 0.14.0

## 0.20.1 (2026-10-16)

### 🩹 Fixes

- **gateway:** let Compute Engine create the moved VM's disk from the snapshot with the VM, and drop the snapshot when the VM cannot be renamed ([2a1aab3](https://github.com/unshoppable/hunt/commit/2a1aab3))

## 0.20.0 (2026-10-16)

### 🚀 Features

- **gateway:** move a stopped session VM to the next zone when its own has no capacity for its start ([#34](https://github.com/unshoppable/hunt/issues/34))

### 🧱 Updated Dependencies

- Updated session to 0.13.4

## 0.19.0 (2026-10-16)

### 🚀 Features

- **gateway:** have the agent's question comment mention the issue's current assignees, so that GitHub notifies them ([b84193d](https://github.com/unshoppable/hunt/commit/b84193d))

## 0.18.0 (2026-10-16)

### 🚀 Features

- **gateway:** give swf sessions a system prompt with the issue's workflow, from reading it to the clean-up ([9584610](https://github.com/unshoppable/hunt/commit/9584610))

### 🧱 Updated Dependencies

- Updated session to 0.13.3

## 0.17.0 (2026-10-16)

### 🚀 Features

- **gateway:** follow swf sessions until the pull request and record the agent's state in the VM ([62c6815](https://github.com/unshoppable/hunt/commit/62c6815))

### 🧱 Updated Dependencies

- Updated session to 0.13.2

## 0.16.0 (2026-10-15)

### 🚀 Features

- **gateway:** poll the issue repositories every 30 seconds ([1f57ad5](https://github.com/unshoppable/hunt/commit/1f57ad5))

## 0.15.0 (2026-10-15)

### 🚀 Features

- **gateway:** delete session VMs stopped for more than a week ([ec765c3](https://github.com/unshoppable/hunt/commit/ec765c3))

### 🧱 Updated Dependencies

- Updated session to 0.13.1

## 0.14.0 (2026-10-15)

### 🧱 Updated Dependencies

- Updated session to 0.13.0

## 0.13.0 (2026-10-14)

### 🧱 Updated Dependencies

- Updated session to 0.12.0

## 0.12.0 (2026-10-14)

### 🚀 Features

- run the sub chats of a remote session on its VM ([85061d5](https://github.com/unshoppable/hunt/commit/85061d5))

### 🧱 Updated Dependencies

- Updated session to 0.11.0

## 0.11.0 (2026-10-14)

### 🧱 Updated Dependencies

- Updated session to 0.10.0

## 0.10.1 (2026-10-14)

### 🧱 Updated Dependencies

- Updated session to 0.9.1

## 0.10.0 (2026-10-14)

### 🚀 Features

- sync the files of remote sessions with the local worktree in both directions ([52f79ef](https://github.com/unshoppable/hunt/commit/52f79ef))

### 🧱 Updated Dependencies

- Updated session to 0.9.0

## 0.9.1 (2026-10-14)

### 🧱 Updated Dependencies

- Updated session to 0.8.1

## 0.9.0 (2026-10-14)

### 🚀 Features

- create a session VM in another zone of the region when its zone has no capacity ([2ccac58](https://github.com/unshoppable/hunt/commit/2ccac58))

### 🧱 Updated Dependencies

- Updated session to 0.8.0

## 0.8.0 (2026-10-14)

### 🚀 Features

- run the services of hunt.json as systemd units, with IAP-free hosts for unguarded ones ([#27](https://github.com/unshoppable/hunt/issues/27))

### 🧱 Updated Dependencies

- Updated session to 0.7.0

## 0.7.0 (2026-10-14)

### 🚀 Features

- choose the machine type of new session VMs in Settings → Remote VM ([0a91dd5](https://github.com/unshoppable/hunt/commit/0a91dd5))

### 🧱 Updated Dependencies

- Updated session to 0.6.0

## 0.6.0 (2026-10-14)

### 🚀 Features

- write the services' log lines with their severity ([5c05eb6](https://github.com/unshoppable/hunt/commit/5c05eb6))

### 🧱 Updated Dependencies

- Updated session to 0.5.0

## 0.5.1 (2026-10-14)

### 🧱 Updated Dependencies

- Updated session to 0.4.1

## 0.5.0 (2026-10-14)

### 🚀 Features

- log Compute Engine calls, VM commands and hunt-ctl's stderr ([e94176c](https://github.com/unshoppable/hunt/commit/e94176c))

### 🧱 Updated Dependencies

- Updated session to 0.4.0

## 0.4.1 (2026-10-14)

### 🧱 Updated Dependencies

- Updated session to 0.3.2

## 0.4.0 (2026-10-14)

### 🚀 Features

- **vm:** log hunt-ctl steps to the journal ([2624b92](https://github.com/unshoppable/hunt/commit/2624b92))
- show the gateway's log lines while a remote session starts ([03dd8da](https://github.com/unshoppable/hunt/commit/03dd8da))

### 🧱 Updated Dependencies

- Updated session to 0.3.1

## 0.3.1 (2026-10-14)

### 🩹 Fixes

- **gateway:** keep the SSH control socket in the service's state directory ([98ae0ca](https://github.com/unshoppable/hunt/commit/98ae0ca))

## 0.3.0 (2026-10-14)

### 🚀 Features

- take the gateway and the swf poller's settings from the infrastructure ([cfc3cbf](https://github.com/unshoppable/hunt/commit/cfc3cbf))

### 🧱 Updated Dependencies

- Updated session to 0.3.0

## 0.2.0 (2026-10-14)

### 🚀 Features

- name session branches like app-framework and review pull requests on their own branch ([#10](https://github.com/unshoppable/hunt/pull/10))

### 🧱 Updated Dependencies

- Updated session to 0.2.0

## 0.1.1 (2026-10-14)

### 🩹 Fixes

- **gateway:** let admins call hunt-api inside a command over SSH ([fe0f58b](https://github.com/unshoppable/hunt/commit/fe0f58b))

## 0.1.0 (2026-10-14)

### 🚀 Features

- deploy the server apps from CI and control remote sessions through the gateway API ([cf48c48](https://github.com/unshoppable/hunt/commit/cf48c48))

### 🧱 Updated Dependencies

- Updated session to 0.1.0