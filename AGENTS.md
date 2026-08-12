# Agent preferences

## Code review

- When asked to review a PR, branch, or local changes: report findings **in the conversation only**.
- Do **not** post PENDING (or submitted) GitHub PR reviews.
- Do **not** create inline review comments via the GitHub API unless the user explicitly asks to post them.

## Parallel agent work

- Give each implementation agent its own branch and isolated git worktree. Never have multiple agents edit the same worktree.
- Run independent work in waves of at most three subagents. A completed idle agent can be evicted automatically, so a fresh agent can take its slot without deleting the earlier task's persisted history.
- For a genuinely fresh task, spawn a uniquely named agent with `fork_turns: "none"` and put all required repository, worktree, scope, validation, and delivery details in its prompt.
- Use `followup_task` only when intentionally continuing the same agent and context. It reuses that agent's existing conversation history.
- Ending the parent turn does not cancel subagents. Their completion messages are queued for the next parent turn.
- `wait_agent` returns early on subagent mailbox activity or new user input. Its default timeout is 30 seconds; requests are clamped to a 10-second minimum and a 1-hour maximum. Waiting itself does not run model inference, though active subagents continue consuming their own tokens.
- When an agent owns a PR, require it to run relevant local checks and monitor/fix GitHub Actions until every required check passes.
- If `gh` authentication or network access appears unavailable in the sandbox, retry the required `gh` command with escalation rather than treating authentication as missing.
