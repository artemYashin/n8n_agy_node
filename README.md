# n8n Agy Chat Model

Use your installed and authenticated **Antigravity CLI (`agy`) as an n8n LLM provider**. The node connects to the **Chat Model** socket of an AI Agent or Basic LLM Chain.

## Requirements

- Self-hosted n8n with community/custom node support; this cannot run on n8n Cloud.
- Node.js 22 or later, and a recent n8n using LangChain Core 1.x. Development uses `n8n-workflow` 2.16.0 and `@langchain/core` 1.2.8.
- `agy` installed and authenticated **as the operating-system user running n8n**. Run `agy models` under that user to check access.
- The CLI must support custom Markdown agents and `--input-format stream-json`.

In Docker, install/authenticate `agy` inside the container or provide its executable and authentication environment there. A CLI installed only on the Docker host is not accessible automatically. Queue-mode workers also need the CLI and its authentication.

## Build and install

This package is not yet published to npm. Build a local package:

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
npm install /absolute/path/to/n8n-nodes-agy-cli-0.1.0.tgz
```

Restart n8n, add an **AI Agent**, and select **Agy Chat Model** on its Chat Model connection. If your installation uses a different n8n user folder, use that folder's `nodes` directory instead.

Set **Model** to an ID returned by `agy models`, or leave it empty for the CLI default. If n8n cannot find the executable, set **Options → CLI Executable** to its absolute path (for example `/home/artem/.local/bin/agy`). This field takes an executable, not a shell command.

The [example workflow](examples/agy-agent.json) connects a Manual Trigger, AI Agent, Agy Chat Model, and Calculator. Import it after installing the package. Node versions may need adjustment for your n8n release.

## System prompts and tools

Set your instructions in the parent AI Agent's **System Message**, or the chain's system message. Each model request creates a temporary custom **primary agent** and puts those instructions in its Markdown system prompt, then selects it with `--agent=n8n-provider`. This is stronger than inserting instructions into the CLI's user prompt. It does not remove all Antigravity scaffolding or guarantee a bare provider-level system-message replacement.

Conversation history is sent as a role-labelled JSON transcript through stdin. n8n owns memory: each model request starts a fresh CLI conversation, without `--continue` or shared conversation IDs. Temporary agent files are removed after completion or failure. Agy may retain conversations and logs in its own application data directory.

Workflow tools use a **JSON response bridge**: the adapter provides their schemas in the system prompt, validates requested names and the response envelope, and returns LangChain tool calls. n8n executes the connected tools and supplies their results on the next model invocation. Tool calling is prompt mediated, not a native model API tool-call channel; reliability depends on the selected model. The adapter avoids Agy's `--json-schema` mode because live tests produced concatenated repair attempts without a usable `structured_output`.

The custom agent declares `tools: []` and asks Agy not to execute its own tools. This is **not an operating-system isolation boundary**: the tested CLI still advertised built-in tools in its startup event. Run n8n/agy under an appropriately restricted account or container. The adapter never enables `--dangerously-skip-permissions`.

## Options and limitations

| Option | Default | Purpose |
| --- | --- | --- |
| Model | CLI default | ID from `agy models` |
| CLI Executable | `agy` | Path/name of the binary |
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

Tests cover roles and Unicode, shell metacharacters, tool binding/results, usage, concurrent isolation, unsupported media, errors, output limits, cancellation, and deadlines. Full installation in a running n8n UI is a separate deployment check.

References: [Agy headless protocol](https://antigravity.google/docs/cli/headless/), [custom agent format](https://antigravity.google/docs/subagents?tab=cli), [n8n chat-model node pattern](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOllama/LmChatOllama.node.ts).
