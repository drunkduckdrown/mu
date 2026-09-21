---
description: Hand a review of the current changes to the reviewer sub-agent
argument-hint: "[what to review]"
---
Review ${ARGUMENTS:-the uncommitted changes in this repository (staged and unstaged)}.

Use the `delegate` tool with one task for the `reviewer` role. Its instructions must be self-contained: say exactly what to review (paths, the diff command to run), what this change is meant to do as far as you know, and ask for findings as `file:line` with the input or state that triggers each defect.

When the report comes back, check each "must fix" finding against the code yourself before repeating it, then give me the confirmed findings most serious first. Do not fix anything yet.
