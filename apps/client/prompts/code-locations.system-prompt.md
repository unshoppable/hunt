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
- Leave the place out for commands, terminal output, error text and code that is in no file yet, such as a proposal.
