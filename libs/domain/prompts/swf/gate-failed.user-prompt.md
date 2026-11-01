Hunt ran the gate of the step `{{step}}` on your result, the checks of hunt.json's `checks` that the repository names
for the step, and these failed:

{{failures}}

Fix them: a failing check is yours, also a flaky test or a warning, and so is a file a check changed or left
uncommitted. Commit, push, leave the working tree clean and write the step result to `.hunt/swf/result.md` again; Hunt
runs the gate once more when your turn ends. This does not count as a return to `implement`: it is
gate run {{gateRuns}} of {{maxGateRuns}}, after which Hunt asks you to escalate to the people.
