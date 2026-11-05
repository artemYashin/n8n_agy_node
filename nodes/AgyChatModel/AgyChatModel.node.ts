import { NodeConnectionTypes, type INodeType, type INodeTypeDescription, type ISupplyDataFunctions, type SupplyData } from 'n8n-workflow';
import { AgyChatModel as ChatModel } from './AgyChatModel.js';

export class AgyChatModel implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Agy Chat Model', name: 'agyChatModel', icon: 'fa:robot',
    group: ['transform'], version: 1,
    description: 'Use the locally authenticated agy CLI as a chat model',
    defaults: { name: 'Agy Chat Model' },
    inputs: [], outputs: [NodeConnectionTypes.AiLanguageModel], outputNames: ['Model'],
    credentials: [{ name: 'agyCliAccount', required: true, displayOptions: { show: { authentication: ['account'] } } }],
    codex: { categories: ['AI'], subcategories: { AI: ['Language Models'] } },
    properties: [
      {
        displayName: 'Requires self-hosted n8n with agy installed. Use the Agy Account node to sign in from n8n, or reuse the server’s existing CLI login. Connect to an AI Agent or LLM Chain’s Model input.',
        name: 'notice', type: 'notice', default: '',
      },
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'existing',
        options: [{ name: 'Existing Server Login', value: 'existing' }, { name: 'Agy CLI Account', value: 'account' }],
        description: 'Both modes use the server’s shared Agy session. The credential supplies the executable used during sign-in.' },
      {
        displayName: 'Model', name: 'model', type: 'string', default: '',
        placeholder: 'gemini-3.8-flash-medium',
        description: 'Model ID from agy models. Leave empty to use the CLI default.',
      },
      {
        displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {},
        options: [
          { displayName: 'CLI Executable', name: 'executable', type: 'string', default: 'agy',
            description: 'Executable name or absolute path on the n8n host, without arguments' },
          { displayName: 'Reasoning Effort', name: 'effort', type: 'options', default: '', options: [
            { name: 'CLI Default', value: '' }, { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' }, { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }, { name: 'Maximum', value: 'max' },
          ] },
          { displayName: 'Timeout (Seconds)', name: 'timeout', type: 'number', default: 120,
            typeOptions: { minValue: 1, maxValue: 3600 } },
          { displayName: 'Max Output (MiB)', name: 'maxOutput', type: 'number', default: 16,
            typeOptions: { minValue: 1, maxValue: 256 } },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const model = this.getNodeParameter('model', itemIndex, '') as string;
    const options = this.getNodeParameter('options', itemIndex, {}) as {
      executable?: string; effort?: string; timeout?: number; maxOutput?: number;
    };
    const authentication = this.getNodeParameter('authentication', itemIndex, 'existing') as string;
    const credential = authentication === 'account' ? await this.getCredentials('agyCliAccount') : undefined;
    return { response: new ChatModel({
      model, executable: credential ? String(credential.executable || 'agy') : options.executable, effort: options.effort,
      timeoutMs: (options.timeout ?? 120) * 1000,
      maxOutputBytes: (options.maxOutput ?? 16) * 1024 * 1024,
    }) };
  }
}
