## 0.33.0 (2026-10-16)

### 🚀 Features

- **client:** colour the sidebar's issue badge amber and the pull request badge green, grey, purple or red by its state on GitHub ([4964eef](https://github.com/unshoppable/hunt/commit/4964eef))

## 0.32.0 (2026-10-16)

### 🚀 Features

- **client:** show the number of a reviewed pull request with its own icon on the sidebar's repository line instead of in the title ([3321365](https://github.com/unshoppable/hunt/commit/3321365))
- **client:** drop the cloud icon from the sidebar rows and show a session's issue as a ticket on its repository line ([191e337](https://github.com/unshoppable/hunt/commit/191e337))

## 0.31.0 (2026-10-16)

### 🚀 Features

- **client:** show the blue session mark also for the sub sessions of a session that runs on a VM ([e0cd3af](https://github.com/unshoppable/hunt/commit/e0cd3af))

## 0.30.0 (2026-10-16)

### 🚀 Features

- **client:** show a blue session mark for a session that runs on a VM instead of the grey or green one ([b8b8e63](https://github.com/unshoppable/hunt/commit/b8b8e63))

## 0.29.0 (2026-10-16)

### 🚀 Features

- **client:** turn the cloud menu into a toggle that hands the session off to the VM or brings it back on a click, without the Open preview entry ([303cfab](https://github.com/unshoppable/hunt/commit/303cfab))

## 0.28.0 (2026-10-16)

### 🚀 Features

- **client:** remove a remote session from the sidebar with an × that keeps its VM, and delete it with its VM from a trash button under the prompt box ([bf3f0f0](https://github.com/unshoppable/hunt/commit/bf3f0f0))
- **client:** follow a session VM the gateway moved to another zone ([d68a904](https://github.com/unshoppable/hunt/commit/d68a904))

### 🩹 Fixes

- **client:** show the guardrail buttons for remote sessions and hide a suggestion marker whose text holds a > ([f968bce](https://github.com/unshoppable/hunt/commit/f968bce))

## 0.27.0 (2026-10-16)

### 🚀 Features

- **client:** let the user pick which remote sessions join the sidebar from the list, which shows their marks and agent state like the sidebar ([b28f051](https://github.com/unshoppable/hunt/commit/b28f051))

## 0.26.2 (2026-10-16)

### 🩹 Fixes

- **client:** list sessions oldest first, so that a new session joins the end of the sidebar and the marks of the existing ones stay put ([b92b46e](https://github.com/unshoppable/hunt/commit/b92b46e))

## 0.26.1 (2026-10-16)

### 🩹 Fixes

- **client:** keep the unsent text of the prompt box with its session instead of carrying it into the next one ([683296c](https://github.com/unshoppable/hunt/commit/683296c))

## 0.26.0 (2026-10-16)

### 🚀 Features

- **client:** mark a session whose agent ended its reply with the question marker, in the chat pane as well ([6954a6c](https://github.com/unshoppable/hunt/commit/6954a6c))

## 0.25.0 (2026-10-16)

### 🚀 Features

- **client:** mark sessions whose agent waits for an answer in the sidebar and the remote list ([2b5ed60](https://github.com/unshoppable/hunt/commit/2b5ed60))

## 0.24.0 (2026-10-16)

### 🚀 Features

- **client:** list pull requests and remote sessions in the start view instead of a popover ([4a04cf3](https://github.com/unshoppable/hunt/commit/4a04cf3))

## 0.23.0 (2026-10-15)

### 🚀 Features

- **client:** drag the top edge of the prompt box to make the text area taller ([8973f8f](https://github.com/unshoppable/hunt/commit/8973f8f))

## 0.22.1 (2026-10-15)

### 🩹 Fixes

- **client:** clear a remote session over one connection, without showing the VM connect steps ([61cc056](https://github.com/unshoppable/hunt/commit/61cc056))

## 0.22.0 (2026-10-15)

### 🚀 Features

- **client:** attach images dropped into the chat, referenced as [Image #n] in the prompt ([66f9d5a](https://github.com/unshoppable/hunt/commit/66f9d5a))

## 0.21.0 (2026-10-15)

### 🚀 Features

- **client:** back up the transcripts of a remote session after every turn ([e93fece](https://github.com/unshoppable/hunt/commit/e93fece))

## 0.20.4 (2026-10-15)

### 🩹 Fixes

- **client:** write the architecture diagram with Claude Fable 5.1 by default ([46ea1ba](https://github.com/unshoppable/hunt/commit/46ea1ba))

## 0.20.3 (2026-10-15)

### 🩹 Fixes

- **client:** send queued prompts once the turn ends, and send a prompt now with ⌘↩ or the row's button ([15e0bed](https://github.com/unshoppable/hunt/commit/15e0bed))
- **client:** start new sessions with effort high unless the user picked another level ([d62cf4c](https://github.com/unshoppable/hunt/commit/d62cf4c))

## 0.20.2 (2026-10-15)

### 🩹 Fixes

- **client:** switch the inspector tabs of a remote session again ([05e5a89](https://github.com/unshoppable/hunt/commit/05e5a89))

## 0.20.1 (2026-10-15)

### 🩹 Fixes

- **client:** continue a remote session here when its VM no longer exists ([ed32a84](https://github.com/unshoppable/hunt/commit/ed32a84))

## 0.20.0 (2026-10-15)

### 🚀 Features

- let the local branch of a remote session follow the commits on its VM ([49cace8](https://github.com/unshoppable/hunt/commit/49cace8))
- commit and push remote sessions from the changelist on their VM ([7816dab](https://github.com/unshoppable/hunt/commit/7816dab))

## 0.19.0 (2026-10-14)

### 🚀 Features

- show each process of a session VM in its own terminal tab ([473dcde](https://github.com/unshoppable/hunt/commit/473dcde))

## 0.18.0 (2026-10-14)

### 🚀 Features

- hand a session off to its VM together with its sub chats ([e536cbf](https://github.com/unshoppable/hunt/commit/e536cbf))

## 0.17.0 (2026-10-14)

### 🚀 Features

- run the sub chats of a remote session on its VM ([85061d5](https://github.com/unshoppable/hunt/commit/85061d5))

## 0.16.2 (2026-10-14)

### 🩹 Fixes

- show the bypass permissions mode in a pastel red ([1be9e36](https://github.com/unshoppable/hunt/commit/1be9e36))

## 0.16.1 (2026-10-14)

### 🩹 Fixes

- keep recreated VM files, local versions of ignored files and pending sends safe in the remote file sync ([681b6b7](https://github.com/unshoppable/hunt/commit/681b6b7))

## 0.16.0 (2026-10-14)

### 🚀 Features

- hide the ports of the session VM's system services from the preview's other ports ([81904f7](https://github.com/unshoppable/hunt/commit/81904f7))

### 🩹 Fixes

- reserve the ports of the session VM's system services instead of hiding them in the client ([4c38a12](https://github.com/unshoppable/hunt/commit/4c38a12))

## 0.15.0 (2026-10-14)

### 🚀 Features

- sync the files of remote sessions with the local worktree in both directions ([52f79ef](https://github.com/unshoppable/hunt/commit/52f79ef))
- have the agent start the services its task needs right after a handoff ([5a63eb4](https://github.com/unshoppable/hunt/commit/5a63eb4))

### 🩹 Fixes

- record content, links and modes safely in the remote file sync and let ignored files through the retrieval ([5b0cbeb](https://github.com/unshoppable/hunt/commit/5b0cbeb))
- keep local edits and files the other side ignores safe in the remote file sync ([b9e74f3](https://github.com/unshoppable/hunt/commit/b9e74f3))

## 0.14.0 (2026-10-14)

### 🚀 Features

- show the step count, a step bar and the elapsed time while a session moves to or from its VM ([a59188f](https://github.com/unshoppable/hunt/commit/a59188f))

## 0.13.0 (2026-10-14)

### 🚀 Features

- hand off or bring back a session while its agent works; the move waits for the turn's end and the VM comes up meanwhile ([b29fe10](https://github.com/unshoppable/hunt/commit/b29fe10))

## 0.12.0 (2026-10-14)

### 🚀 Features

- create a session VM in another zone of the region when its zone has no capacity ([2ccac58](https://github.com/unshoppable/hunt/commit/2ccac58))

## 0.11.0 (2026-10-14)

### 🚀 Features

- commit the checked files of the changelist and push the session's branch ([9452b60](https://github.com/unshoppable/hunt/commit/9452b60))

## 0.10.1 (2026-10-14)

### 🩹 Fixes

- show the last four characters of the saved GitHub token in its field ([8e788c6](https://github.com/unshoppable/hunt/commit/8e788c6))

## 0.10.0 (2026-10-14)

### 🚀 Features

- run the services of hunt.json as systemd units, with IAP-free hosts for unguarded ones ([#27](https://github.com/unshoppable/hunt/issues/27))

## 0.9.0 (2026-10-14)

### 🚀 Features

- choose the machine type of new session VMs in Settings → Remote VM ([0a91dd5](https://github.com/unshoppable/hunt/commit/0a91dd5))

## 0.8.0 (2026-10-14)

This was a version bump only for client to align it with other projects, there were no code changes.

## 0.7.1 (2026-10-14)

### 🩹 Fixes

- **client:** bring retrieved sessions back in auto mode ([5b7cc4e](https://github.com/unshoppable/hunt/commit/5b7cc4e))

## 0.7.0 (2026-10-14)

### 🚀 Features

- show the gateway's log lines while a remote session starts ([03dd8da](https://github.com/unshoppable/hunt/commit/03dd8da))

## 0.6.0 (2026-10-14)

### 🚀 Features

- take the gateway and the swf poller's settings from the infrastructure ([cfc3cbf](https://github.com/unshoppable/hunt/commit/cfc3cbf))

## 0.5.0 (2026-10-14)

### 🚀 Features

- **client:** show the app version in the settings title bar ([#11](https://github.com/unshoppable/hunt/pull/11))

## 0.4.0 (2026-10-14)

### 🚀 Features

- name session branches like app-framework and review pull requests on their own branch ([#10](https://github.com/unshoppable/hunt/pull/10))

## 0.3.0 (2026-10-14)

### 🚀 Features

- deploy the server apps from CI and control remote sessions through the gateway API ([cf48c48](https://github.com/unshoppable/hunt/commit/cf48c48))