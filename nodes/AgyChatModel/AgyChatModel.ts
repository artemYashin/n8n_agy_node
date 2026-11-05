import { randomUUID } from 'node:crypto';
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { ToolDefinition, BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { runAgy, type CliOptions } from './cli.js';

interface CallOptions extends BaseChatModelCallOptions {
  tools?: ToolDefinition[];
}

export function textContent(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('Agy Chat Model supports text messages only; images, audio, and files are unsupported');
    }
    return block.text;
  }).join('\n');
}

const adapterInstructions = `You are a chat model supplying the next assistant message for an n8n workflow.
The user input contains a JSON conversation transcript. Continue that conversation; do not describe the transcript.
Respect the roles in the transcript. Tool messages contain results from tools already executed by n8n.
Do not use any Antigravity built-in tools, browse, inspect files, or run commands.
When workflow tools are listed, request them only through the specified JSON output. n8n executes them.
Never invent tool results. If a tool result is needed, return a tool call and wait for the next invocation.`;

export class AgyChatModel extends BaseChatModel<CallOptions> {
  lc_namespace = ['n8n', 'agy'];
  constructor(readonly cliOptions: CliOptions = {}) {
    super({ maxRetries: 0 });
  }

  _llmType() { return 'agy-cli'; }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<CallOptions>): Runnable<BaseLanguageModelInput, AIMessageChunk, CallOptions> {
    return this.withConfig({ ...kwargs, tools: tools.map((tool) => convertToOpenAITool(tool)) });
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const tools = options.tools ?? [];
    const system = messages.filter((message) => message.type === 'system').map(textContent).join('\n\n');
    const transcript = messages.filter((message) => message.type !== 'system').map((message) => ({
      role: message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type,
      content: textContent(message),
      ...('tool_calls' in message ? { tool_calls: message.tool_calls } : {}),
      ...('tool_call_id' in message ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.name ? { name: message.name } : {}),
    }));
    const toolInstructions = tools.length ? `\nAvailable workflow tools: ${JSON.stringify(tools)}
Return exactly one object with content (string) and tool_calls (array).
For a final answer, put the answer in content and set tool_calls to [].
For tool requests, use tool_calls entries with name and arguments (a JSON object matching the tool parameters).
Example shape: {"content":"","tool_calls":[{"name":"tool_name","arguments":{"parameter":"value"}}]}.
Do not include id, type, or function wrappers in tool_calls entries.
Return only the JSON object, without Markdown fences or extra text.
Do not wrap the response object in content. Do not execute these tools yourself.` : '';
    // agy's --json-schema can concatenate repair attempts without structured_output.
    // Request one envelope in the custom system prompt and validate it ourselves.
    const result = await runAgy(this.cliOptions, JSON.stringify({ messages: transcript }),
      `${adapterInstructions}\n\n${system}${toolInstructions}`, options.signal);
    let content = result.response;
    const toolCalls: NonNullable<AIMessage['tool_calls']> = [];
    if (tools.length) {
      let output: unknown = result.structured_output;
      if (output === undefined) {
        try { output = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); }
        catch { throw new Error('Agy did not return a valid workflow tool response'); }
      }
      if (!output || typeof output !== 'object' || !('content' in output) ||
          typeof output.content !== 'string' || !('tool_calls' in output) || !Array.isArray(output.tool_calls)) {
        throw new Error('Agy returned a malformed workflow tool response');
      }
      content = output.content;
      for (const call of output.tool_calls) {
        if (!call || typeof call.name !== 'string' || !tools.some((tool) => tool.function.name === call.name) ||
            !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
          throw new Error('Agy returned an unknown tool or invalid tool arguments');
        }
        toolCalls.push({ id: `call_${randomUUID()}`, name: call.name, args: call.arguments, type: 'tool_call' });
      }
    }
    // CLI has no stop-sequence option. Apply stops to final text only.
    if (!toolCalls.length && options.stop?.length) {
      const positions = options.stop.filter(Boolean).map((stop) => content.indexOf(stop)).filter((index) => index >= 0);
      if (positions.length) content = content.slice(0, Math.min(...positions));
    }
    const usage = result.usage;
    const message = new AIMessage({
      content, tool_calls: toolCalls,
      response_metadata: { conversation_id: result.conversation_id, model: this.cliOptions.model || 'agy default' },
      ...(usage ? { usage_metadata: {
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens,
      } } : {}),
    });
    return { generations: [{ text: content, message }], llmOutput: usage ? {
      tokenUsage: { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.total_tokens },
    } : {} };
  }
}
