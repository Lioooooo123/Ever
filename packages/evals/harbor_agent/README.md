# Ever Harbor Agent

`ever_agent:EverAgent` is loaded by Harbor from `PYTHONPATH`. It verifies the pinned Ever artifact, installs it into the benchmark environment, resolves auth from a named host environment variable, submits a native unattended Ever Task, and emits an ATIF trajectory.

Credentials are copied to `/tmp/ever-agent/auth.json` inside the disposable benchmark environment. The daemon reads them and passes the resolved credential to the Resident Worker over its owner-only startup channel; the Worker process tree is sandboxed from `auth.json`. The Eval config and artifacts contain only the environment variable name. Credential-enabled runs require a reviewed, digest-pinned benchmark because benchmark container code is inside the credential boundary.
