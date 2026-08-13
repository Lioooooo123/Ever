# Security Policy

This document describes Ever's security model and trust boundaries.

Ever is a coding agent that runs locally within the security boundary
of the user that is running it.  It's the responsibiltiy of the user to monitor
its operations or to contain it within a container, virtual machine or other
Sandbox solution.

Ever treats the local user account and files writable by that account as inside
the same trust boundary as the Ever process itself. If an attacker can modify files
under the user's home directory, workspace, shell startup files, environment, or
Ever configuration, they can generally influence Ever or other local developer tools.
Reports that depend on such prior local write access are not security
vulnerabilities unless they demonstrate how Ever grants that write access or crosses
an operating-system privilege boundary.

Ever relies on users installing trustworthy extensions and loading trustworthy
skills and only using Ever within trusted repositories. Files
like `AGENTS.md` or instructions in comments can be used to prompt inject the
coding agent trivially and this cannot be protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in Ever or another package in
this repository, open a private report through GitHub Security Advisories for
`Lioooooo123/Ever`.

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports.  We will review
reports and coordinate disclosure as appropriate.

## Scope

Security issues in Ever's distributed packages, command-line tools, APIs, and
repository code are in scope.

## Out Of Scope

- Local code execution or sandboxing behavior (Ever intentionally does not provide a sandbox by default)
- Behavior of Ever extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Isuses caused by non trustworthy MITM proxies
- Public internet exposure of an Ever installation
- Prompt injection attacks
- Exposed secrets that are third-party/user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.ever`,
  legacy `~/.ever` data imported by Ever, workspace files, `AGENTS.md`, skills, extensions,
  extension configuration, dotfiles, and files synchronized through NFS, roaming
  profiles, or dotfile managers, unless the report shows how Ever itself grants
  that access.
- Issues caused by intentionally weakened user configuration.
- Resource/DOS claims that require trusted local input/config against Ever.
- Reports about malicious model output.
- User-approved or user-initiated local actions presented as vulnerabilities.

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact.  Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension/skill are not security
vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted Ever
configuration file cause Ever to execute commands, load attacker-controlled tools,
send credentials to an attacker-controlled endpoint, or otherwise change behavior
is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or latest
`main`.  For dependency reports, include evidence that the shipped dependency is
affected and that the issue is reachable through Ever.
