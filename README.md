# n8n Agy Chat Model

Use **Antigravity CLI (`agy`) as an n8n LLM provider**, with automatic CLI installation and Google sign-in from n8n. The node connects to the **Chat Model** socket of an AI Agent or Basic LLM Chain.

## Requirements

- Self-hosted n8n with community/custom node support; this cannot run on n8n Cloud.
- Node.js 22 or later, and a recent n8n using LangChain Core 1.x. Development uses `n8n-workflow` 2.16.0 and `@langchain/core` 1.2.8.
- Internet access to Google's release storage on first use, plus a writable runtime cache. No separate CLI installation is needed.
- Linux, macOS, or Windows on x64 or ARM64. Linux uses Google's static musl build, compatible with Alpine-based n8n containers.

In Docker, leave **CLI Executable** set to `auto`. The node installs the binary inside the container under the n8n service user. Workers each need access to the runtime cache and authenticated Agy environment.

## Build and install

In self-hosted n8n, open **Settings → Community Nodes → Install** and enter `n8n-nodes-agy-cli`. Then use the sign-in flow below.

For manual installation, run this as the n8n service user, then restart n8n:

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install n8n-nodes-agy-cli
```

To build a local package from source instead:

```sh
git clone git@github.com:artemYashin/n8n_agy_node.git
cd n8n_agy_node
npm ci
npm test
npm pack
```

Install the generated archive into your n8n community-node directory, using the same user and Node.js runtime as n8n:

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
# If this directory has no package.json yet:
npm init -y
npm install /absolute/path/to/n8n-nodes-agy-cli-0.2.0.tgz
```

Restart n8n, add an **AI Agent**, and select **Agy Chat Model** on its Chat Model connection. If your installation uses a different n8n user folder, use that folder's `nodes` directory instead.

In **Model**, choose **From List** to search models available to your signed-in account, or **By ID** to type an ID or expression manually. Leave the value empty for Agy's default. Existing version-1 model nodes keep their text field; add a new Agy Chat Model node or upgrade it to node version 2 to get the picker.

Leave **CLI Executable** set to `auto` for managed installation. To use your own binary, enter its absolute path. The legacy default `agy` also selects automatic installation. A custom executable path overrides automatic installation and must exist inside the n8n container.

The [example workflow](examples/agy-agent.json) connects a Manual Trigger, AI Agent, Agy Chat Model, and Calculator. Import it after installing the package. Node versions may need adjustment for your n8n release.

## Sign in inside n8n

No terminal login or separate CLI installation is needed. First use downloads Agy automatically. Optionally run **Agy Account → Install CLI** first to pre-download it; this is helpful when your proxy or workflow imposes a short request timeout.

1. Add a **Manual Trigger → Agy Account** setup workflow, or import [agy-sign-in.json](examples/agy-sign-in.json).
2. On **Agy Account**, create an **Agy CLI Account** credential. Leave **CLI Executable** set to `auto` and **One-Time Authorization Code** empty, then save.
3. Select **Start Sign-In** and execute the setup node manually. Open the `authorizationUrl` from the output in your browser.
4. Sign in to Google. Copy the authorization code or full callback-page URL that Google returns.
5. Edit the same credential, paste the value into **One-Time Authorization Code**, and save. Select **Complete Sign-In** and execute the node again within ten minutes. Do not rerun Start Sign-In: doing so invalidates the previous attempt.
6. After the output says `signedIn`, clear the one-time code from the credential and save. Use **Check Connection** to list the available models.
7. In **Agy Chat Model**, choose **Authentication → Agy CLI Account** and select that credential. Its executable path overrides **Options → CLI Executable**. Set system instructions on your parent AI Agent as usual.

**Cancel Sign-In** cancels only a pending attempt; it does not log out the current account. Authentication errors omit raw CLI output so codes and tokens are not returned in execution results. The one-time code is stored in n8n's encrypted credential store, never as a node parameter. Agy handles PKCE, the exchange, and storage/refresh of the actual login session using its own credential store. The adapter never reads or exports those tokens.

**Account scope:** this connects the **shared Agy account of the n8n operating-system user**. Multiple Agy CLI Account credentials do not isolate Google accounts, and signing in with another Google account changes the identity used by other workflows on that host. Use separate n8n/CLI environments for account isolation. Setup is intended for trusted instance administrators; the node only permits manual executions and serializes pending sign-ins within its process.

**Deployment:** the pending login lives in memory. Start and Complete must execute in the **same n8n process**; a restart or a different worker loses the attempt. Perform setup with one execution process, not a load-balanced worker pool. Workers need the authenticated CLI environment too. Persist Agy's credential storage across container replacement. This flow does not add a public callback endpoint or require an inbound port.

## Automatic CLI installation and Docker

The npm package includes the installer and pinned release manifests, not the large platform binaries. First use downloads Agy **1.5.1** directly from Google's `storage.googleapis.com/antigravity-public/antigravity-cli/` release storage, verifies the pinned SHA-512 checksum, and atomically installs the executable. It does not run a remote shell installer, require root, or depend on npm install scripts.

The default cache is `~/.n8n/agy-runtime/<version>/<platform>/`. Set `AGY_CLI_CACHE_DIR` in the n8n process environment to use another writable location. Allow about 500 MiB of free space for download staging and extraction. The x64 Linux archive is about 69 MiB. Downloads have a three-minute timeout; failed staging files are removed, and the next invocation can retry. Cached executables are reused without another download or checksum scan. The pinned checksum verifies the downloaded payload, not later changes to the installed file by local processes or Agy itself.

For standard Docker deployments, persist both the normal n8n directory (which contains the runtime cache) and Agy's session data. Merge these mounts into your existing Compose service; retain your existing n8n volume:

```yaml
services:
  n8n:
    volumes:
      - n8n_data:/home/node/.n8n
      - agy_data:/home/node/.gemini
volumes:
  n8n_data:
  agy_data:
```

For offline deployments, prepopulate the cache or set an absolute executable path. If the cache filesystem is mounted `noexec`, use an executable filesystem via `AGY_CLI_CACHE_DIR`. Automatic setup currently has live coverage on Linux x64; the other platform manifests are pinned but have not been executed in this environment.

## System prompts and tools

Set your instructions in the parent AI Agent's **System Message**, or the chain's system message. Each model request creates a temporary custom **primary agent** and puts those instructions in its Markdown system prompt, then selects it with `--agent=n8n-provider`. This is stronger than inserting instructions into the CLI's user prompt. It does not remove all Antigravity scaffolding or guarantee a bare provider-level system-message replacement.

Conversation history is sent as a role-labelled JSON transcript through stdin. n8n owns memory: each model request starts a fresh CLI conversation, without `--continue` or shared conversation IDs. Temporary agent files are removed after completion or failure. Agy may retain conversations and logs in its own application data directory.

Workflow tools use a **JSON response bridge**: the adapter provides their schemas in the system prompt, validates requested names and the response envelope, and returns LangChain tool calls. n8n executes the connected tools and supplies their results on the next model invocation. Tool calling is prompt mediated, not a native model API tool-call channel; reliability depends on the selected model. The adapter avoids Agy's `--json-schema` mode because live tests produced concatenated repair attempts without a usable `structured_output`.

The custom agent declares `tools: []` and asks Agy not to execute its own tools. This is **not an operating-system isolation boundary**: the tested CLI still advertised built-in tools in its startup event. Run n8n/agy under an appropriately restricted account or container. The adapter never enables `--dangerously-skip-permissions`.

## Options and limitations

| Option | Default | Purpose |
| --- | --- | --- |
| Model | CLI default | ID from `agy models` |
| CLI Executable | `auto` | Automatically installed CLI, or an explicit executable path |
| Reasoning Effort | CLI default | Low through maximum, subject to model support |
| Timeout | 120 seconds | Per-model-call deadline |
| Max Output | 16 MiB | Maximum CLI stdout per call |

- Text-only input; images, audio, and files are explicitly rejected.
- Responses are buffered until completion. LangChain's streaming fallback emits a completed message; there is no live token streaming.
- Stop sequences are applied to returned text, not to generation itself. Temperature and max-token controls are not exposed because this CLI does not offer corresponding flags.
- Tool argument shapes are validated by the receiving n8n/LangChain tool. Unknown tool names and malformed response envelopes are rejected by the adapter.
- CLI startup and structured-output processing add latency and consume your Agy account's quota. CLI usage includes agent overhead.
- Cancellation and deadlines kill the CLI process group on Linux/macOS. Windows terminates the direct process; descendant process cleanup is not guaranteed.
- CLI execution is a privileged capability. Only trusted workflow authors should configure this node, especially its executable path.

## Development and verification

```sh
npm ci
npm test          # Compile + deterministic subprocess/adapter tests
npm run test:live # Uses real agy and account quota: system prompt + tool-call cycle
```

Optional live-test environment variables: `AGY_EXECUTABLE`, `AGY_MODEL`.

Tests cover roles and Unicode, shell metacharacters, tool binding/results, usage, concurrent isolation, unsupported media, errors, output limits, cancellation, deadlines, sign-in ownership, expiry, secret redaction, automatic installation, cache reuse, checksum rejection, archive filtering, and both model-selection modes. Live checks verify the downloaded Linux x64 binary; completing a new Google consent flow and installation in a running n8n UI remain deployment checks. The local Docker daemon was unavailable, so an actual container test has not been run.

References: [Agy headless protocol](https://antigravity.google/docs/cli/headless/), [custom agent format](https://antigravity.google/docs/subagents?tab=cli), [n8n chat-model node pattern](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOllama/LmChatOllama.node.ts).

## Standalone Docker API

For an independent OpenAI-compatible HTTP API with Google sign-in UI and live text streaming, see [docker/README.md](docker/README.md). Run `docker compose up` from the `docker` directory; n8n is not required.
