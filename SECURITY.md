# Security Policy

## Supported Versions

Janus is under active development. Security fixes are provided for the latest
official release.

| Version          | Supported |
| ---------------- | --------- |
| Latest release   | Yes       |
| Older releases   | No        |

Official desktop builds are published on the
[Releases](https://github.com/iLearn-Agent/Janus/releases) page. If you are
running a build obtained from anywhere else, please replace it with an official
build before reporting.

## Reporting a Vulnerability

Please do not report security issues through public issues, discussions, or
pull requests.

The preferred channel is GitHub's private vulnerability reporting: open the
**Security** tab of this repository and click **Report a vulnerability**. That
keeps the report private and gives us one place to discuss and coordinate a fix.

Please include:

- a description of the issue and the impact you believe it has;
- the affected version and platform;
- steps to reproduce, ideally as a minimal proof of concept;
- whether a self-hosted cloud deployment is required to trigger it, or whether
  the desktop application alone is affected;
- any logs, screenshots, or traces that help.

## What to Expect

- acknowledgement of your report;
- an initial assessment and severity triage;
- updates while a fix is in progress, and credit in the release notes if you
  would like it.

Please allow us a reasonable window to ship a fix before disclosing the issue
publicly. We will not pursue or support legal action against researchers who
follow this policy and act in good faith.

## Scope

In scope:

- the desktop application (`src/`), including the Electron main process, the
  renderer, and the preload/IPC boundary;
- credential handling, including model-service API keys and `auth.json` at rest;
- local data, including SQLite storage, task memory, and task memory encryption;
- account and principal isolation between users and workspaces;
- agent permission and approval enforcement, including device grants and their
  scopes;
- the optional cloud services (`cloud/`, `deploy/`), including the API,
  authentication, job queues, and the migration and evolution worker boundaries.

Out of scope:

- third-party model providers; report those to the provider directly;
- issues that only arise from a self-hosted deployment misconfigured in a way
  the [self-hosting guide](docs/self-hosting.md) explicitly warns against;
- social engineering of maintainers or users;
- issues that require access to data, accounts, or machines you do not own;
- denial of service through unrealistic resource consumption.

Please do not test against cloud instances you do not own. Use a local or
self-hosted deployment.

## Related Documentation

- [Self-hosting guide](docs/self-hosting.md)
- [Task memory encryption](docs/task-memory-encryption.md)
- [Account and principal isolation](docs/account-principal-isolation-v1.md)
- [Database evolution policy](docs/database-evolution-policy.md)
- [Cluster evolution contract](docs/cluster-evolution-contract.md)
- [Application logging](docs/application-logging.md)

## Automated Checks

`npm run cloud:rehearse-evolution-security` runs the evolution worker security
rehearsal.
