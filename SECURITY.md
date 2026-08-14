# Security

Please report vulnerabilities through the private repository's GitHub Security Advisory flow rather than a public issue.

## Boundaries

- The current local-process provider targets Windows and treats PID as insufficient identity; stop operations also require a matching process creation time.
- Workspace authority is derived from a live DSH Session through `sandboxPolicy.resolve({ session })`; browser-supplied cwd values are never authoritative.
- Launch commands containing common credential, JWT, Bearer, URL-credential, or connection-string shapes are rejected.
- Runner environments remove `DSH_*` and common password/token/key variables.
- Logs are persisted locally and common credential shapes are redacted at API/tool read boundaries. Applications may emit unknown secret formats, so callers should request only the minimum required tail.
- A single DSH Host per `DSH_HOME` is the supported coordination model in this release. Multi-Host use requires storage CAS/lease fencing that is not yet implemented.
