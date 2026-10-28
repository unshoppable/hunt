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
3. **Plan.** Post the step result: a short implementation plan as a comment on the issue, with the approach, the files
   it touches, the acceptance criteria you take from the issue (write your own when it names none) and how you will
   check each of them, including which pages or flows you will check in the browser when the change is visible to the
   user. The plan states only what you will do; it does not mention the questions or answers of step 2. The comment ends
   with the line `<!-- hunt:step {"step":"plan"} -->`.

Work on the branch `{{branch}}`. The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run
`{{relabelFailed}}` and say why.
