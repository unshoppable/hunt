## 0.100.0 (2026-10-23)

### 🚀 Features

- **client:** the diagram status badge shows how long ago the diagram was generated ([6484bb4](https://github.com/unshoppable/hunt/commit/6484bb4))

## 0.99.0 (2026-10-23)

### 🚀 Features

- **client:** the Diff tab shows the count of review comments as a blue badge while the session reviews a pull request ([4b3c09a](https://github.com/unshoppable/hunt/commit/4b3c09a))
- **client:** diagrams generate in a background agent, independent of the chat ([f5ffb0b](https://github.com/unshoppable/hunt/commit/f5ffb0b))
- **client:** the editor breadcrumb, Go to File, Find in Files and the usages popup show the file icon before the path ([5058a19](https://github.com/unshoppable/hunt/commit/5058a19))

## 0.98.0 (2026-10-23)

### 🚀 Features

- **client:** the diff and guardrails windows show the file icon before the file path in their header ([e9fcf36](https://github.com/unshoppable/hunt/commit/e9fcf36))

## 0.97.0 (2026-10-23)

### 🚀 Features

- **client:** the pull request list shows the pull requests it listed last at once and a spinner while it asks GitHub again ([8201518](https://github.com/unshoppable/hunt/commit/8201518))
- **client:** show usages and rename reach Angular templates through the Angular language server ([c5eb5cc](https://github.com/unshoppable/hunt/commit/c5eb5cc))

### 🩹 Fixes

- **client:** the pull request list keeps "You approved" after a later comment review ([a5aa3d6](https://github.com/unshoppable/hunt/commit/a5aa3d6))

## 0.96.3 (2026-10-23)

### 🩹 Fixes

- **client:** the review comment editor shows its text at 14px ([bfa2143](https://github.com/unshoppable/hunt/commit/bfa2143))
- **client:** the review comment editor, its preview and the reply field show their text at 15px ([c31f561](https://github.com/unshoppable/hunt/commit/c31f561))

## 0.96.2 (2026-10-23)

### 🩹 Fixes

- **client:** review comment cards show their text at 15px and their headers at 13px ([8629465](https://github.com/unshoppable/hunt/commit/8629465))

## 0.96.1 (2026-10-23)

### 🩹 Fixes

- **client:** review comment cards show their text at 14px ([acb8562](https://github.com/unshoppable/hunt/commit/acb8562))
- **client:** the review bar and the line between the two "+" run unbroken across deleted lines and comment cards ([2f0ad7d](https://github.com/unshoppable/hunt/commit/2f0ad7d))

## 0.96.0 (2026-10-23)

### 🚀 Features

- **client:** dragging the review "+" over several lines joins its two ends with a blue line, as on GitHub ([98546ba](https://github.com/unshoppable/hunt/commit/98546ba))

## 0.95.0 (2026-10-23)

### 🚀 Features

- **client:** the editor marks every line of a file the changes add with a change stripe ([57d29f8](https://github.com/unshoppable/hunt/commit/57d29f8))

## 0.94.0 (2026-10-23)

### 🚀 Features

- **client:** opening a file in the editor from the diff view or a diff window puts the caret on its first change ([920ef57](https://github.com/unshoppable/hunt/commit/920ef57))

## 0.93.0 (2026-10-23)

### 🚀 Features

- **client:** another local branch can be pulled or force pulled from its upstream, and the branch tree says what a pull did ([777c094](https://github.com/unshoppable/hunt/commit/777c094))
- **client:** a line separates the remote branches from the local ones in the branch tree ([4919dca](https://github.com/unshoppable/hunt/commit/4919dca))

## 0.92.0 (2026-10-23)

### 🚀 Features

- **client:** a toolbar above the branch tree fetches origin and deletes the local branches origin lacks ([23c0481](https://github.com/unshoppable/hunt/commit/23c0481))

### 🩹 Fixes

- **client:** Update in a branch's context menu works like pull --ff-only and leaves a branch ahead of its upstream as it is ([dcb8317](https://github.com/unshoppable/hunt/commit/dcb8317))

## 0.91.1 (2026-10-23)

### 🩹 Fixes

- **client:** a script that finished with exit code 0 reports it in green instead of red ([2ac6d2a](https://github.com/unshoppable/hunt/commit/2ac6d2a))

## 0.91.0 (2026-10-23)

### 🚀 Features

- **client:** rules and ADR folders get a README on their first guardrail that says when a guardrail is a rule and when an ADR ([5814edd](https://github.com/unshoppable/hunt/commit/5814edd))
- **client:** the Terminal tab shows for local sessions too, and package.json scripts get run buttons in the editor ([00855da](https://github.com/unshoppable/hunt/commit/00855da))

### 🩹 Fixes

- **client:** the Guardrail button drops its highlight once the suggested guardrail was taken up in the guardrail chat ([06d3706](https://github.com/unshoppable/hunt/commit/06d3706))

## 0.90.0 (2026-10-22)

### 🚀 Features

- **client:** imports from path aliases and packages get their WebStorm color from the language server ([43dd827](https://github.com/unshoppable/hunt/commit/43dd827))

### 🩹 Fixes

- **client:** the popup of inserted lines shows only its toolbar, above the block, so the inserted lines stay visible ([9f15368](https://github.com/unshoppable/hunt/commit/9f15368))

## 0.89.0 (2026-10-22)

### 🚀 Features

- **client:** file paths in inline code of a reply open the file in the editor, also in the sub chat popover ([b448dd7](https://github.com/unshoppable/hunt/commit/b448dd7))

## 0.88.2 (2026-10-22)

### 🩹 Fixes

- **client:** an agent's change to a file open in a diff view is no longer written back with the old text on the next save ([c0fb4da](https://github.com/unshoppable/hunt/commit/c0fb4da))

## 0.88.1 (2026-10-22)

### 🩹 Fixes

- **client:** editor tabs and the guardrails window mark unsaved files with the same blue dot as the diff, the changelist and the project tree ([876c0d3](https://github.com/unshoppable/hunt/commit/876c0d3))

## 0.88.0 (2026-10-22)

### 🚀 Features

- **client:** the sub chat popover's header has a link button that jumps to the sub chat in the main window, also from the editor, diff and guardrails windows ([94659a9](https://github.com/unshoppable/hunt/commit/94659a9))

## 0.87.0 (2026-10-22)

### 🚀 Features

- **client:** the editable side of every diff view renames with ⌘Ü, reformats with ⌘G and opens the usages popup on ⌘click on a declaration, like the editor panes ([6a3eea6](https://github.com/unshoppable/hunt/commit/6a3eea6))

## 0.86.0 (2026-10-22)

### 🚀 Features

- **client:** closing a folder in any tree also closes every folder below it, so reopening it shows its subfolders closed ([922bb7e](https://github.com/unshoppable/hunt/commit/922bb7e))
- **client:** folder rows of the change list have a context menu that copies the folder's absolute path and reverts its listed files, and ⌃⇧C copies the path of the row under the cursor ([2ab5f6d](https://github.com/unshoppable/hunt/commit/2ab5f6d))

## 0.85.0 (2026-10-22)

### 🚀 Features

- **client:** the editor's project tree selects several rows: ⇧-click selects every row up to the clicked one, ⌘-click adds or removes a row, and copy path and delete (also ⌘⌫) act on all selected rows ([0956f8c](https://github.com/unshoppable/hunt/commit/0956f8c))

## 0.84.0 (2026-10-22)

### 🚀 Features

- **client:** the editor's project tree has a context menu that copies a row's absolute path (⌃⇧C for the selected row) and deletes a file or folder, closing its tabs ([556b746](https://github.com/unshoppable/hunt/commit/556b746))

## 0.83.0 (2026-10-22)

### 🚀 Features

- **client:** the change list's context menu copies the file's absolute path, and ⌃⇧C copies the selected change's path ([1255a15](https://github.com/unshoppable/hunt/commit/1255a15))
- **client:** opening a change in the editor selects the file in the editor's project tree ([2e3e182](https://github.com/unshoppable/hunt/commit/2e3e182))
- **client:** the change list's context menu opens the file in the editor, and ⇧⌘2 opens the selected change there ([03ba2a2](https://github.com/unshoppable/hunt/commit/03ba2a2))

## 0.82.0 (2026-10-22)

### 🚀 Features

- **client:** declined guardrail suggestions go into .claude/declined-guardrails.jsonl of the repository, and its CLAUDE.md tells agents to search them before they suggest a guardrail ([b8818dd](https://github.com/unshoppable/hunt/commit/b8818dd))
- **client:** the agent searches the declined guardrail suggestions in .hunt/declined-guardrails.jsonl of its worktree before it suggests one, instead of getting them all in its system prompt ([e1ddcc4](https://github.com/unshoppable/hunt/commit/e1ddcc4))

## 0.81.0 (2026-10-22)

### 🚀 Features

- **client:** opening a session offers to add a Guardrails section to CLAUDE.md, next to the ADR section, that tells agents which guardrails the repository keeps, where each kind lives and what belongs in a new one ([d0b8996](https://github.com/unshoppable/hunt/commit/d0b8996))
- **client:** declining a suggested guardrail asks for the reason (too specific, already recorded, not wanted) and records it per repository; agents started there are told never to suggest those again nor anything as narrow ([1405be2](https://github.com/unshoppable/hunt/commit/1405be2))

## 0.80.1 (2026-10-22)

### 🩹 Fixes

- **client:** the agent offers a guardrail only for broadly reusable knowledge (a generic solution, a recurring problem and its fix, a reusable workflow), never for a one-off decision about one piece of code or task ([1d42b91](https://github.com/unshoppable/hunt/commit/1d42b91))

## 0.80.0 (2026-10-22)

### 🚀 Features

- **client:** ⌘Ü renames the symbol at the caret and its usages across the project like WebStorm's Rename dialog, optionally also in comments, strings and non-code files with a preview ([7c81464](https://github.com/unshoppable/hunt/commit/7c81464))

### 🩹 Fixes

- **client:** while the usage endpoint refuses reads, a token account reads its plan limits from the rate-limit headers of a one-token Fable request ([ceb6349](https://github.com/unshoppable/hunt/commit/ceb6349))

## 0.79.0 (2026-10-22)

### 🚀 Features

- **client:** ⌘B selects every occurrence of the selected text in the code editors ([e80d6a5](https://github.com/unshoppable/hunt/commit/e80d6a5))
- **client:** the selection card of a chat opens its lines in the editor on a click on the file name and folds via a chevron on the left ([f151da3](https://github.com/unshoppable/hunt/commit/f151da3))
- **client:** a click on the file name of a file reference or code block header opens the editor too ([a76d966](https://github.com/unshoppable/hunt/commit/a76d966))
- **client:** the guardrail chat declines a suggested guardrail with a "Decline" button above send, the × beside the Guardrail button is gone ([b79a4ec](https://github.com/unshoppable/hunt/commit/b79a4ec))

### 🩹 Fixes

- **client:** plan usage of a token account reads the usage endpoint directly, keeps the last limits while it refuses reads for too many requests and says when the next read starts ([9f4f459](https://github.com/unshoppable/hunt/commit/9f4f459))
- **client:** usages also list references in tsconfig projects none of whose files is open ([8c303b9](https://github.com/unshoppable/hunt/commit/8c303b9))

## 0.78.0 (2026-10-22)

### 🚀 Features

- **client:** ⌘S saves every file with unsaved edits also with the focus in the project tree, the changelist or the chat ([3e38128](https://github.com/unshoppable/hunt/commit/3e38128))
- **client:** ⌘S saves every file with unsaved edits, also those of closed tabs, other windows and the diff views ([a9ce6aa](https://github.com/unshoppable/hunt/commit/a9ce6aa))

## 0.77.1 (2026-10-22)

### 🩹 Fixes

- **client:** interfaces and type aliases take WebStorm's light pink again, classes keep their darker pink ([5fc0fca](https://github.com/unshoppable/hunt/commit/5fc0fca))

## 0.77.0 (2026-10-22)

### 🚀 Features

- **client:** a code block that shows lines of a file gets a header row with the file and "Open in editor" ([436be39](https://github.com/unshoppable/hunt/commit/436be39))
- **client:** the Own diff marks own lines another session overwrote on disk with that session's mark, whose hover shows the lines on disk now ([12c7805](https://github.com/unshoppable/hunt/commit/12c7805))

## 0.76.0 (2026-10-22)

### 🚀 Features

- **client:** a guardrail suggestion can be declined with the × beside the "Guardrail" button, which then drops its highlight ([3aeced3](https://github.com/unshoppable/hunt/commit/3aeced3))

## 0.75.0 (2026-10-22)

### 🚀 Features

- **client:** a reply lists up to four places it changed with "Open in editor", the summary holds at most three bullets and the code a sub chat came from ([a9b3250](https://github.com/unshoppable/hunt/commit/a9b3250))

## 0.74.0 (2026-10-22)

### 🚀 Features

- **client:** the file search also finds classes and symbols, from the language server and from declarations in every source file ([a2280ef](https://github.com/unshoppable/hunt/commit/a2280ef))

## 0.73.0 (2026-10-22)

### 🚀 Features

- **client:** closing an editor tab or window keeps unsaved edits, and the project tree and change list mark the file with a blue dot ([abfbb73](https://github.com/unshoppable/hunt/commit/abfbb73))
- **client:** every session and sub session shows its inspector tab, its selected diff file and its editor tabs with caret and scroll position as it was left, also after a restart ([4050461](https://github.com/unshoppable/hunt/commit/4050461))

## 0.72.1 (2026-10-22)

### 🩹 Fixes

- **client:** interfaces and type aliases are colored like classes ([a886dbf](https://github.com/unshoppable/hunt/commit/a886dbf))

## 0.72.0 (2026-10-22)

### 🚀 Features

- **client:** code copied from Hunt's editors is pasted into the prompt as a Markdown code block, and sent prompts show their code blocks highlighted ([0befe56](https://github.com/unshoppable/hunt/commit/0befe56))

### 🩹 Fixes

- **client:** type aliases take WebStorm's interface color, and the angle brackets of TypeScript generics its operator color ([5a45730](https://github.com/unshoppable/hunt/commit/5a45730))

## 0.71.0 (2026-10-22)

### 🚀 Features

- **client:** ⌘G in the editor removes unused imports and formats the file with the project's Prettier, or with tsgo when the project has none ([6504593](https://github.com/unshoppable/hunt/commit/6504593))

## 0.70.0 (2026-10-21)

### 🚀 Features

- **client:** queued prompts show a Send now button, and ⌃↩ (or ⌘↩, set in Settings → Keymap) sends the prompt box now or, while it is empty, the first queued prompt ([d86223e](https://github.com/unshoppable/hunt/commit/d86223e))

## 0.69.0 (2026-10-21)

### 🚀 Features

- **client:** the diff keeps unsaved edits when another file is shown, and files with unsaved edits get a blue dot in the changelist and the project tree ([d27d019](https://github.com/unshoppable/hunt/commit/d27d019))

## 0.68.2 (2026-10-21)

### 🩹 Fixes

- **client:** the Architecture tab generates a diagram only on a click, and while the agent runs a chat turn the generate button keeps its label and a hint says the diagram waits for the turn to end ([67fd68c](https://github.com/unshoppable/hunt/commit/67fd68c))

## 0.68.1 (2026-10-21)

### 🩹 Fixes

- **client:** the context meter and Guardrail button sit right above the prompt box, below the queued prompts ([c21a571](https://github.com/unshoppable/hunt/commit/c21a571))

## 0.68.0 (2026-10-20)

### 🚀 Features

- **client:** the agent suggests a guardrail for non-obvious findings too and in a reply that asks a question, never for what an existing guardrail says, and the Guardrail button turns violet with the suggested kind ([38079b5](https://github.com/unshoppable/hunt/commit/38079b5))

## 0.67.0 (2026-10-20)

### 🚀 Features

- **client:** the diff views drop their Save button, ⌘S saves, and a blue dot after the path marks unsaved edits ([01c4746](https://github.com/unshoppable/hunt/commit/01c4746))
- **client:** a prompt sent in one window shows in every window together with its running turn, and loading a conversation renders the chat once instead of once per replayed update ([6c87274](https://github.com/unshoppable/hunt/commit/6c87274))

### 🩹 Fixes

- **client:** Settings → Keymap notes that Space in the change list checks or unchecks the selected file too ([8c15e83](https://github.com/unshoppable/hunt/commit/8c15e83))
- **client:** a click on a sub chat button in the editor gutter opens the chat instead of folding the line, the fold chevrons move right of the buttons, and a sub chat shows its selection expanded ([5c7ce68](https://github.com/unshoppable/hunt/commit/5c7ce68))
- **client:** changing the push target answers sooner: one round trip asks origin for the target and its start branch, a remote session records the target on its VM in the background, and the button shows a spinner while it works ([f5a36b9](https://github.com/unshoppable/hunt/commit/f5a36b9))

### 🔥 Performance

- **client:** the local file watch of a remote session starts at once instead of first reading every file of the worktree, node_modules included ([6090aba](https://github.com/unshoppable/hunt/commit/6090aba))

## 0.66.1 (2026-10-20)

### 🩹 Fixes

- **client:** every window shares one document per file like WebStorm: an edit, the unsaved mark and a save show in all windows at once, and the language server no longer reports false "Cannot redeclare" errors after an agent edit ([0f0c622](https://github.com/unshoppable/hunt/commit/0f0c622))

## 0.66.0 (2026-10-20)

### 🚀 Features

- **client:** drag the top edge of the sub chat's input area to make its text area taller, remembered like the prompt box's height ([7a73db1](https://github.com/unshoppable/hunt/commit/7a73db1))

## 0.65.1 (2026-10-20)

### 🩹 Fixes

- **client:** the language server sees files created, changed or deleted on disk, so usages include files the agent created ([d6406d4](https://github.com/unshoppable/hunt/commit/d6406d4))

## 0.65.0 (2026-10-20)

### 🚀 Features

- **client:** every tree navigates with the arrow keys like WebStorm: ↑/↓ move the selection, → opens a folder or steps into it, ← closes it or goes to its parent, Home/End jump to the ends, Enter toggles a folder or opens the file, Space checks the row ([9b1ea51](https://github.com/unshoppable/hunt/commit/9b1ea51))

### 🩹 Fixes

- **client:** usages find calls the agent added to a file that is loaded without a tab, e.g. as an import, since every loaded document reloads from disk after an agent edit ([6992b02](https://github.com/unshoppable/hunt/commit/6992b02))

## 0.64.0 (2026-10-20)

### 🚀 Features

- **client:** the commit message stays in the changelist's box after a commit ([f376912](https://github.com/unshoppable/hunt/commit/f376912))

## 0.63.0 (2026-10-20)

### 🚀 Features

- **client:** text selected in the preview of Go to File and Find in Files shows the sparkle button, which opens a sub chat about it over the dialog ([5052854](https://github.com/unshoppable/hunt/commit/5052854))

## 0.62.0 (2026-10-20)

### 🚀 Features

- **client:** the context menu of a session in the sidebar opens its worktree in the terminal, as a new WezTerm tab or else a Terminal.app window ([9e13323](https://github.com/unshoppable/hunt/commit/9e13323))

## 0.61.0 (2026-10-20)

### 🚀 Features

- **client:** completion works like WebStorm's: it opens by itself at an object's members, ⌥Space or ⌃Space opens it, every row shows its type and a docs column the declaring type, signature and docs, also on a diff's editable side, which now shares the editor tab's document ([56bf528](https://github.com/unshoppable/hunt/commit/56bf528))

## 0.60.4 (2026-10-20)

### 🩹 Fixes

- **client:** ⌘W on the editor's last tab leaves an empty editor area, and only the next ⌘W closes the editor window ([aeedc50](https://github.com/unshoppable/hunt/commit/aeedc50))

## 0.60.3 (2026-10-20)

### 🩹 Fixes

- **client:** a hide glob with a trailing slash such as admin-ui/ hides that folder at any depth with everything in it, as in .gitignore ([3c98010](https://github.com/unshoppable/hunt/commit/3c98010))

## 0.60.2 (2026-10-20)

### 🩹 Fixes

- **client:** Find in Files splits list and preview at a draggable line that it remembers, and a search opened with the editor's selection shows its matches right away instead of only after the next keystroke ([78f81b8](https://github.com/unshoppable/hunt/commit/78f81b8))

## 0.60.1 (2026-10-20)

### 🩹 Fixes

- **session:** checking whether a service answers no longer sends it requests, so its log no longer fills with 404 errors every few seconds ([1a12509](https://github.com/unshoppable/hunt/commit/1a12509))

## 0.60.0 (2026-10-20)

### 🚀 Features

- the push target is the git upstream of the session's branch, which a plain git push in the worktree uses too, and a right click on a session changes it; the sidebar shows a running turn or a question of a remote session before it is opened; the Git tab resets the branch to a commit ([7fa8987](https://github.com/unshoppable/hunt/commit/7fa8987))

## 0.59.1 (2026-10-20)

### 🔥 Performance

- **session:** a resumed session VM connects up to 30 s sooner, and the progress says whether the VM wakes up or boots ([1c13251](https://github.com/unshoppable/hunt/commit/1c13251))

## 0.59.0 (2026-10-20)

### 🚀 Features

- **client:** green dots mark the Preview and Terminal tabs while something runs on the VM; the PR Description tab shows only for pull request reviews ([deeda04](https://github.com/unshoppable/hunt/commit/deeda04))

## 0.58.0 (2026-10-20)

### 🚀 Features

- **client:** the Preview and Terminal tabs hide stopped services ([048c128](https://github.com/unshoppable/hunt/commit/048c128))

## 0.57.1 (2026-10-20)

### 🔥 Performance

- **client:** connecting to a session with a long chat no longer freezes the window while the agent replays the history; unchanged messages and tool rows skip re-rendering ([5e354d7](https://github.com/unshoppable/hunt/commit/5e354d7))

## 0.57.0 (2026-10-20)

### 🚀 Features

- **client:** the red traffic light hides the main window instead of quitting Hunt, so the agents keep running; a click on the Dock icon shows it again ([1e6938c](https://github.com/unshoppable/hunt/commit/1e6938c))

## 0.56.1 (2026-10-20)

### 🩹 Fixes

- **client:** links open in the default browser instead of inside Hunt's window, and the red traffic light of the main window quits Hunt instead of leaving it running with hidden windows ([f9efda8](https://github.com/unshoppable/hunt/commit/f9efda8))

## 0.56.0 (2026-10-20)

### 🚀 Features

- **client:** message times come only from the agent's transcript; a live message shows its time once its turn ended, a prompt Hunt sent found through the parent chain of the turn's first reply or tool call ([07c7594](https://github.com/unshoppable/hunt/commit/07c7594))
- **client:** the chat's notice that the agent waits for an answer starts with the session mark's ? icon ([1236618](https://github.com/unshoppable/hunt/commit/1236618))

### 🩹 Fixes

- **client:** the ? of a session mark's question badge is bold again, the chat notice's stays semibold ([e158fc8](https://github.com/unshoppable/hunt/commit/e158fc8))
- **client:** restore the ? icon of the chat's notice that the agent waits for an answer, which the message times commit reverted ([dafc290](https://github.com/unshoppable/hunt/commit/dafc290))
- **client:** the ? of the question badge is semibold ([f90f628](https://github.com/unshoppable/hunt/commit/f90f628))
- **client:** the ? icon of the chat's notice that the agent waits for an answer is 16px ([136fb9b](https://github.com/unshoppable/hunt/commit/136fb9b))
- **client:** the ? in a session mark's question badge is 1px larger ([09bee8f](https://github.com/unshoppable/hunt/commit/09bee8f))
- **client:** the question badge and unseen dot of a session mark are 2px larger and the ? inside 1px larger ([d0485b3](https://github.com/unshoppable/hunt/commit/d0485b3))
- **client:** an unseen response shows as a green dot at the session mark's corner instead of a green mark, so the mark stays grey for local and blue for remote sessions ([7c03564](https://github.com/unshoppable/hunt/commit/7c03564))
- **client:** a session mark keeps its grey or blue colour while the agent waits for an answer; only the ? badge marks the question ([506412a](https://github.com/unshoppable/hunt/commit/506412a))

## 0.55.0 (2026-10-20)

### 🚀 Features

- **client:** chat messages show when they were written, the time alone for today and the date before it for an earlier day, also for messages a loaded session replays from its transcript ([b69acc4](https://github.com/unshoppable/hunt/commit/b69acc4))
- **client:** the prompt Hunt sends after a session moved to its VM shows as a one-line notice instead of a user bubble ([2aaa6bc](https://github.com/unshoppable/hunt/commit/2aaa6bc))

## 0.54.0 (2026-10-20)

### 🚀 Features

- **client:** the remote sessions list shows the sessions whose agent waits for an answer without "Show stopped", since the gateway suspends their idle VMs ([02e5114](https://github.com/unshoppable/hunt/commit/02e5114))

## 0.53.0 (2026-10-19)

### 🚀 Features

- **client:** the branch search of a new session is taller and holds a New branch button that prefills the typed name, which Enter also runs while no branch matches; New branch… no longer heads the branch list ([603c943](https://github.com/unshoppable/hunt/commit/603c943))

## 0.52.0 (2026-10-19)

### 🚀 Features

- **client:** the branch of a new worktree session is named after its base branch with a running number, such as feat/general/master-1, instead of a slug of the prompt and the session id ([0d7c8c5](https://github.com/unshoppable/hunt/commit/0d7c8c5))

## 0.51.0 (2026-10-19)

### 🚀 Features

- **client:** the base branch dropdown of a new session gets a search field that filters the branches, sits next to the button and takes the typing, so a branch is found without scrolling a list of every branch ([840b69f](https://github.com/unshoppable/hunt/commit/840b69f))

## 0.50.0 (2026-10-19)

### 🚀 Features

- **client:** pushing from the changelist first opens a popover that names the branch on origin it lands on, the commit button gets a menu with Commit and Push, the session's repository and branch show below the prompt box, the delete button of a remote session moves beside its title, the editor window closes with its last tab, sub sessions of a VM session no longer show as on the VM, and the sync label stays hidden while the files are in sync ([77902b2](https://github.com/unshoppable/hunt/commit/77902b2))

## 0.49.2 (2026-10-19)

### 🩹 Fixes

- **client:** Hunt removes the variables npm run and Volta leave in its environment, so agents, terminals and git hooks it starts run the node version a project pins ([5d16d7b](https://github.com/unshoppable/hunt/commit/5d16d7b))

## 0.49.1 (2026-10-19)

### 🔥 Performance

- **client:** Find in Files keeps the texts of every session's worktree in memory from its first search until the session is removed, instead of only the last three searched worktrees, so switching between sessions never reloads them ([eb81ae8](https://github.com/unshoppable/hunt/commit/eb81ae8))
- **client:** Find in Files keeps the project files' text in memory per worktree like an IDE's index and searches it on every core, re-reading only files whose size or modification time changed, and runs on every keystroke without a pause; a search now takes 5–30 ms instead of 200–450 ms (git grep walked the worktree for untracked files on every search), and opening the dialog loads the files once (~0.4 s). Regex mode uses Rust regex syntax (no look-around or backreferences) ([43e2dd3](https://github.com/unshoppable/hunt/commit/43e2dd3))

## 0.49.0 (2026-10-19)

### 🚀 Features

- **client:** Settings → Keymap lists every keyboard shortcut Hunt handles itself (sessions, chat, changelist, Save, Go to File, Find in Files and the editor's tab and navigation keys) and binds each command to other or additional keys; a change applies at once in every window, a key that types text needs ⌘, ⌃ or ⌥, and two commands that listen in the same place are flagged when they share a key ([5186c73](https://github.com/unshoppable/hunt/commit/5186c73))

### 🩹 Fixes

- **client:** in Find in Files hovering a match only highlights its row; a click selects it for the preview and a double click opens it ([ece7341](https://github.com/unshoppable/hunt/commit/ece7341))

## 0.48.0 (2026-10-19)

### 🚀 Features

- **client:** ⇧⌘F opens "Find in Files" like WebStorm's: a full-text search over the session's worktree through git grep (tracked and untracked files, never ignored or binary ones) with Match Case (⌥C), Words (⌥W), Regex (⌥X) and a file mask such as *.ts, !*.spec.ts; it lists the matching lines with their matches marked, previews the selected one and opens it at the match (⇧Enter in a right split), starting with the editor's selection or the last query ([0721dbd](https://github.com/unshoppable/hunt/commit/0721dbd))

## 0.47.2 (2026-10-19)

### 🩹 Fixes

- **client:** a new worktree gets the ignored files of the repository's hooks folder (husky's generated .husky/_) from its checkout, and an existing one gets them when its session opens, so commits in a worktree no longer fail with .husky/_/husky.sh: No such file or directory ([69e1853](https://github.com/unshoppable/hunt/commit/69e1853))

## 0.47.1 (2026-10-19)

### 🩹 Fixes

- **client:** the branch and push target lines under a session in the sidebar are a step larger and lighter so that they read as easily as the title ([b00fe31](https://github.com/unshoppable/hunt/commit/b00fe31))

## 0.47.0 (2026-10-19)

### 🚀 Features

- **client:** the Git log's author and date columns resize by dragging their borders, and the branch tree has a button that deletes every local branch without a branch on origin after one confirmation ([f81919c](https://github.com/unshoppable/hunt/commit/f81919c))
- **client:** "New branch" in the push target dialog creates the session's own branch on origin and makes it the push target in one click ([511f7f8](https://github.com/unshoppable/hunt/commit/511f7f8))
- **client:** "Change push target…" lists "New branch…" first, which empties the field and creates the typed name on origin off the current target ([210f0fe](https://github.com/unshoppable/hunt/commit/210f0fe))
- **client:** every dialog resizes by dragging its edges and remembers its size; "Change push target…" offers to create a branch origin lacks ([c8e980e](https://github.com/unshoppable/hunt/commit/c8e980e))
- **client:** the sidebar groups the sessions by repository under a heading with its name; the repository line of a session is gone, its pull request or issue badge sits on the push-target line ([fd55ca4](https://github.com/unshoppable/hunt/commit/fd55ca4))
- **client:** a parent session's row in the sidebar shows the branch on origin its push lands on, between its branch and its repository ([7095926](https://github.com/unshoppable/hunt/commit/7095926))
- **client:** the push target is the session branch's upstream: set at creation, changed from the Git tab's branch menu, carried to the VM and taken over from it at every connect ([b68f42b](https://github.com/unshoppable/hunt/commit/b68f42b))
- **client:** "New branch…" in the start view's branch menu names the branch a session creates, in a worktree or the checkout ([f16e412](https://github.com/unshoppable/hunt/commit/f16e412))
- **client:** the session's branch in the Git tab shows where its push lands on a second line ([c4dabeb](https://github.com/unshoppable/hunt/commit/c4dabeb))
- **client:** branch menu in the Git tab: rebase, merge, update, push, rename, delete and fetch, following a remote session's VM ([170dd37](https://github.com/unshoppable/hunt/commit/170dd37))
- **client:** the Git tab opens on the session's branch and marks where its push lands ([4681e4f](https://github.com/unshoppable/hunt/commit/4681e4f))

### 🩹 Fixes

- **client:** a session's title keeps the whole first line of its prompt up to 200 characters instead of 48, so the chat header and the sidebar show as much of it as their width allows ([1a4cea5](https://github.com/unshoppable/hunt/commit/1a4cea5))
- **client:** the Git log reads like IntelliJ's: subject, author and date in fixed columns, branch and tag labels compact at the right end of the subject instead of a chip per ref spilling into the other columns ([f794f8b](https://github.com/unshoppable/hunt/commit/f794f8b))
- **client:** commit, push, rebase, merge and update of a remote session work on the local worktree when the session is not connected to its VM, as for a local session; the VM's branch follows at the next connect, a rebase included, and a retrieval keeps a local branch the VM's stayed behind ([3467c7d](https://github.com/unshoppable/hunt/commit/3467c7d))
- **client:** changing the push target of a remote session no longer waits on its VM: the records change first, a VM that is off or unreachable gets the target at the next connect, and the branch created on origin is not fetched again ([da70154](https://github.com/unshoppable/hunt/commit/da70154))
- **client:** the push target dialog's field only filters the branch list; "New branch…" opens a name field, prefilled with the session's own branch, that creates it on origin and makes it the target ([5eccf17](https://github.com/unshoppable/hunt/commit/5eccf17))
- **client:** "New branch…" in the push target dialog is a secondary button in the footer, not a list row ([69f1945](https://github.com/unshoppable/hunt/commit/69f1945))
- **client:** the Git tab's log has no branch field any more; the branch tree alone filters the log ([17cb7dd](https://github.com/unshoppable/hunt/commit/17cb7dd))
- **client:** sub sessions in the sidebar read like their parent: same title weight and colour, subtitle in the sidebar font ([3d1990d](https://github.com/unshoppable/hunt/commit/3d1990d))
- **client:** the push target under the session's branch sits close below the name, in the tree's font size ([5e9b0f9](https://github.com/unshoppable/hunt/commit/5e9b0f9))

## 0.46.0 (2026-10-19)

### 🚀 Features

- **client:** commit a remote session's files here, with this Mac's Git, hooks and identity, and keep the branch at the same commit on both sides, whoever committed ([f6f8b2d](https://github.com/unshoppable/hunt/commit/f6f8b2d))
- **client:** Git tab after Diff with the commit log and its graph, the branch tree, and the files, details and diff of a commit ([f432c89](https://github.com/unshoppable/hunt/commit/f432c89))

## 0.45.1 (2026-10-19)

### 🩹 Fixes

- **client:** rebase a remote session's branch on this Mac before the push, and let the VM follow the rebased commit ([8bc04c9](https://github.com/unshoppable/hunt/commit/8bc04c9))

## 0.45.0 (2026-10-18)

### 🚀 Features

- **client:** push lands on the branch the session was created from, rebased onto it when it moved on; the worktree branch never reaches origin ([938e2c2](https://github.com/unshoppable/hunt/commit/938e2c2))

## 0.44.0 (2026-10-18)

### 🚀 Features

- transcripts of a remote session stream live both ways, and .hunt/sessions.md tells the agents of a worktree about one another ([d875510](https://github.com/unshoppable/hunt/commit/d875510))

## 0.43.0 (2026-10-18)

### 🚀 Features

- push a remote session's branch from this Mac, and a poller session's from its VM with the stored token (hunt-ctl push --stored, protocol 9) ([c0e4b19](https://github.com/unshoppable/hunt/commit/c0e4b19))
- **client:** ⌘click on a changed line of the diff's left side goes to the declaration when the name still exists ([4a8e72c](https://github.com/unshoppable/hunt/commit/4a8e72c))
- architecture tab with six diagram types, inline commit box and file filter in the changelist, queued prompts for every session, and swf answer delivery ([b78ef11](https://github.com/unshoppable/hunt/commit/b78ef11))

## 0.42.0 (2026-10-18)

### 🚀 Features

- **client:** a chat of a locked worktree connects its session's VM on its own instead of asking ([a70a399](https://github.com/unshoppable/hunt/commit/a70a399))

## 0.41.0 (2026-10-18)

### 🚀 Features

- sub chats of a remote session run on this Mac, and connecting a remote session applies the Claude account selected now ([df1e413](https://github.com/unshoppable/hunt/commit/df1e413))

## 0.40.1 (2026-10-18)

### 🔥 Performance

- faster start of session VMs: operation waits, a 2 s readiness poll, the release check in the same call and an early connect of the desktop ([13c594e](https://github.com/unshoppable/hunt/commit/13c594e))

## 0.40.0 (2026-10-18)

### 🚀 Features

- live two-way file sync of remote sessions through a sync helper on the VM, and a read-only local worktree while the VM cannot be reached ([3dc8a42](https://github.com/unshoppable/hunt/commit/3dc8a42))

## 0.39.1 (2026-10-18)

### 🩹 Fixes

- **client:** hide the permission mode of a remote session, whose agent always bypasses permissions ([db8b065](https://github.com/unshoppable/hunt/commit/db8b065))

## 0.39.0 (2026-10-17)

### 🚀 Features

- remote secrets for the services of session VMs, maintained in Hunt under Settings → Remote VM ([f2dd755](https://github.com/unshoppable/hunt/commit/f2dd755))

## 0.38.0 (2026-10-17)

### 🚀 Features

- declare the ignored files a service needs per service as worktreeInclude in hunt.json ([d576906](https://github.com/unshoppable/hunt/commit/d576906))

## 0.37.0 (2026-10-17)

### 🚀 Features

- name the private files of a repository in its hunt.json (privateFiles) instead of the app's settings ([85bc8c4](https://github.com/unshoppable/hunt/commit/85bc8c4))

## 0.36.1 (2026-10-17)

### 🩹 Fixes

- **client:** copy the private files of the repository's checkout into every new worktree, files inside ignored folders included ([e1daecb](https://github.com/unshoppable/hunt/commit/e1daecb))

## 0.36.0 (2026-10-17)

This was a version bump only for client to align it with other projects, there were no code changes.

## 0.35.0 (2026-10-17)

### 🚀 Features

- send the local tokens to a poller session's relay too, which takes them only where its VM stores none (hunt-ctl start/clear --keep-stored, protocol 6) ([4c221c3](https://github.com/unshoppable/hunt/commit/4c221c3))

## 0.34.0 (2026-10-16)

### 🚀 Features

- **client:** connect the stopped sub chats of a remote session behind the session once it connected to its VM ([7af525e](https://github.com/unshoppable/hunt/commit/7af525e))

### 🔥 Performance

- **client:** connect to a running session VM directly instead of through the gateway's start, which costs seconds for its boot wait and release check ([5cb8e2b](https://github.com/unshoppable/hunt/commit/5cb8e2b))

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