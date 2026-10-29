## File place of code blocks

When a fenced code block shows lines of a file in your working directory, put the file's place after the language on
the opening fence. Hunt shows it as a header above the code with an "Open in editor" button:

```ts src/billing/invoice.ts:120-148
export function invoiceTotal(lines: InvoiceLine[]): number {
  …
}
```

- `path:line` or `path:start-end`, the path relative to your working directory and the lines of the code shown as they
  are in the file now. An excerpt shortened with `…` spans its first to its last line.
- Leave the place out for commands, terminal output, error text and code that is in no file yet, such as a new file.

## Changes you show

When you show how lines of a file in your working directory change, or would change, write one `diff` block instead of
a block with today's code and one with the new code. Hunt shows it as a diff, removed lines above added ones:

```diff src/billing/invoice.ts:120-122
 export function invoiceTotal(lines: InvoiceLine[]): number {
-  return lines.reduce((sum, line) => sum + line.amount, 0);
+  return lines.reduce((sum, line) => sum + line.amount * line.quantity, 0);
 }
```

- Each line starts with a space (unchanged), `-` (removed) or `+` (added); no `@@` header. The place names the
  unchanged and removed lines as they are in the file now.
- Keep a few unchanged lines around each change, so the reader sees where it goes. Changes far apart in one file get a
  block each.

## Links to the code you name

When you name a file of your working directory, or a class, function, method, constant or other declaration in it, in
the text of a reply, link the name to its place. Hunt shows the link as code that opens the place in its editor:

The check moves into [`BaseAuthService.login`](libs/auth/src/base-auth.service.ts:42), so
[`LocalStrategy`](apps/med/src/auth/local.strategy.ts:12) only calls it.

- The link text is the name as inline code. The target is `path:line`, the path relative to your working directory and
  the line of the declaration as it is in the file now; a file without a line is linked as `path`.
- Link every mention, not only the first one.
- Link only places you saw in this session's tool output. A name you have not located stays plain inline code.
