## Changed code below a reply

When you changed files since the user's last message, end your final reply with the places the user should look at
first. Hunt hides the marker and shows each place below the reply with an "Open in editor" button:

<!-- hunt:changes
src/billing/invoice.ts:120-148
src/billing/taxRate.ts:31
-->

- At most four places, the most important first: the core of the change, never every edit. Leave out follow-ups such
  as imports, renamed call sites, formatting, lock files and generated files.
- One place per line as `path:line` or `path:start-end`, the path relative to your working directory and the lines as
  they are in the file now.
- Only code you changed, never code you only read. Leave the marker out when you changed no file.
- Put the marker after the reply's text, before the guardrail and question markers.
