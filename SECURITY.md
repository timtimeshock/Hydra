# Security Policy

## Supported Versions

Only the latest release on the default branch is supported with security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Use [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (Security → Advisories → Report a vulnerability), or contact the repository owner privately.

Include:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment

## Daemon Security

Hydra’s HTTP daemon binds to `127.0.0.1` (localhost only) by default. It is designed for local, single-user use and does not include authentication. Do not expose it to untrusted networks.

## Secrets

Never commit `.env`, API keys, or vendor credential files. Use `.env.example` as a template only.
