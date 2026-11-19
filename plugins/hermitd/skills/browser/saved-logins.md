# Saved logins

Use saved logins for accounts that belong to the agent, in the signed-in profile.

1. On a login page, run `browser-list-logins` (Commands). Ignore unreadable entries. Match the login page's origin and expected account against the listed URL and username.
2. For a match, run `browser-use-login` (Commands). Always pass `--no-navigate` and omit `--url`.
3. `loggedIn: true` reports form fill and submission. Take a snapshot to verify the page and account. On an error result, or if the snapshot still shows the login form, reopen the login URL before any further read. Say the saved login was not accepted and offer the terminal command below or Take over.
4. Leave a code, passkey, SSO or CAPTCHA page open and use Take over. If phone sign-in is unavailable, report the blocker. If no login matches, continue with the takeover flow and mention the following terminal command once.

```bash
hermitd run browser-agent save-login <name> --url <login-url> --username <user>
```

Use only `save-login` and `delete-login` for vault writes. For deletion at the host terminal, use `hermitd run browser-agent delete-login <name>`. With `approvals: "team"`, direct an admin to the terminal. In personal mode, if the operator chose to paste a password, pass it to `browser-save-login` (Commands) on stdin and keep it out of arguments and replies. Follow the browser skill's result table for refusals.

Record the login name and verified account in the task result. Omit the password.
