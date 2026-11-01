Step `plan` for GitHub issue #{{number}} of {{repo}}: {{title}}
{{url}}

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

## Issue, opened by @{{author}} on {{createdAt}}

{{body}}

## Comments

{{comments}}

## Your task

1. **Read the task.** Read the issue and its comments, then the repository's guardrails: README, CLAUDE.md,
   `.claude/rules/*.md`, its skills, its ADRs (`docs/adr/` or wherever it keeps them), its hunt.agent.md and any other
   instructions it holds. Then find the code the issue is about.
2. **Clarify questions.** When a question remains that only a person can answer, ask it as "Questions to the people"
   says, with `{{relabelQuestion}} --title "❓ RÜCKFRAGE: <title>"` to mark the issue and `{{relabelResume}} --title
   "<title>"` once the answer arrived. Do not plan before the answer.
3. **Plan.** Write the step result to `.hunt/swf/result.md`: a short implementation plan with the approach, the files
   it touches, the acceptance criteria you take from the issue (write your own when it names none) and how each of them
   is to be checked, including which pages or flows to check in the browser when the change is visible to the user.
   Write it for a reader who has nothing but this file: the implement and verify steps run in fresh conversations and
   work from `.hunt/swf/steps/01-plan.md`, where Hunt keeps it. The plan states only what is to be done; it does not
   mention the questions or answers of step 2. The file ends with the line `<!-- hunt:step {"step":"plan"} -->`.

Work on the branch `{{branch}}`. The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run
`{{relabelFailed}}` and say why.
