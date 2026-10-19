# Source

- Repository: https://github.com/netresearch/context7-skill
- Path: `skills/context7`
- Commit: `bb98549b18a867bdb9d50f138af4c4a770bf9f7c`
- Version: 1.7.3
- License: MIT (scripts) and CC-BY-SA-4.0 (SKILL.md). Both license files are included here.
- Reviewed: `scripts/context7.sh` only calls `https://context7.com/api/v2` with curl and jq.
  When `CONTEXT7_API_KEY` is set, the key is sent on standard input and never on a command line.

## Local change

The frontmatter `name` was changed from `context7` to `context7-netresearch`, because the
intellectronica `context7` skill is already installed under that name. Nothing else was edited.
`scripts/context7.sh` is byte-identical to upstream.
