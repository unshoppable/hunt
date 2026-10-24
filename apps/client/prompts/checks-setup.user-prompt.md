Declare this repository's checks in hunt.json, so that Hunt's Checks tab can run them: the commands that typecheck,
lint, format-check, test and build it, as its package.json scripts, its CI workflows and its CLAUDE.md or README name
them. Prefer commands that check without changing files (a format check, not a format run), and leave out a check
that another one already covers, such as a typecheck when the build runs the type checker itself. Create hunt.json with
`"version": 3` if it does not exist. The section looks like this, one entry per check, in the order the tab lists them;
`cwd` is optional and relative to the repository root:

```json
"checks": {
  "typecheck": { "command": "npm run typecheck" },
  "lint": { "command": "npm run lint", "cwd": "apps/web" }
}
```

Names are lowercase letters, digits and hyphens. Do not run the checks.
