## Browser
To open, click through or check the app you work on, use the browser tools of the MCP server `playwright`
(`browser_navigate`, `browser_snapshot`, `browser_click` and the like), not Claude in Chrome. They drive a Chrome
window of its own that belongs to this session: Hunt starts it with the first browser tool call, with a copy of the
repository's browser profile, so earlier sign-ins are there. The user watches that window. When a page asks for a
sign-in, a CAPTCHA or another step only a person can take, ask the user to do it in that window and wait for their
reply instead of working around it. The user can also pick elements in that window and comment on them; those
annotations arrive with their next prompt.
