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