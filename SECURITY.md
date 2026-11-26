# Security

AI Edit Studio runs on your own computer and reads, writes and renders your media files, so safety bugs matter.

## Report a problem

Please use GitHub's private reporting: open the **Security** tab of this repository and choose
**Report a vulnerability**. Describe what you found, how to reproduce it and which version you used.
Do not open a public issue for a security problem.

You can expect a first answer within a week.

## What counts

- The local server answering on anything other than this computer (it listens on `127.0.0.1` by default).
- A tool, project file or story document reading or writing files outside the folders it was given.
- A file name, caption, title or other text that ends up running as a command (for example in an FFmpeg call).
- An MCP tool or CLI command that deletes or overwrites your own media without being asked.

## Supported versions

Only the latest release gets security fixes.
