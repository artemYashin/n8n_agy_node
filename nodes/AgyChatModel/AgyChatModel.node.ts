import { NodeConnectionTypes, type INodeType, type INodeTypeDescription, type ISupplyDataFunctions, type SupplyData, type ILoadOptionsFunctions, type INodeListSearchResult } from 'n8n-workflow';
import { AgyChatModel as ChatModel } from './AgyChatModel.js';
import { listModels } from '../AgyAccount/auth.js';

export class AgyChatModel implements INodeType {
  methods = { listSearch: {
    async searchModels(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
      const authentication = this.getNodeParameter('authentication', 'existing');
      const options = this.getNodeParameter('options', {}) as { executable?: string };
      const credential = authentication === 'account' ? await this.getCredentials('agyCliAccount') : undefined;
      const executable = credential ? String(credential.executable || 'auto') : options.executable || 'auto';
      const models = [{ name: 'CLI Default', value: '' }, ...await listModels(executable)];
      const query = filter?.toLowerCase() || '';
      return { results: models.filter((model) => `${model.name} ${model.value}`.toLowerCase().includes(query)) };
    },
  } };
  description: INodeTypeDescription = {
    displayName: 'Agy Chat Model', name: 'agyChatModel', icon: 'file:agy.svg',
    group: ['transform'], version: [1, 2],
    description: 'Use the locally authenticated agy CLI as a chat model',
    defaults: { name: 'Agy Chat Model' },
    inputs: [], outputs: [NodeConnectionTypes.AiLanguageModel], outputNames: ['Model'],
    credentials: [{ name: 'agyCliAccount', required: true, displayOptions: { show: { authentication: ['account'] } } }],
    codex: { categories: ['AI'], subcategories: { AI: ['Language Models'] } },
    properties: [
      {
        displayName: 'Agy installs automatically on first use (internet access required). Use Agy Account to sign in from n8n, then connect this node to an AI Agent or LLM Chain’s Model input.',
        name: 'notice', type: 'notice', default: '',
      },
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'existing',
        options: [{ name: 'Existing Server Login', value: 'existing' }, { name: 'Agy CLI Account', value: 'account' }],
        description: 'Both modes use the server’s shared Agy session. The credential supplies the executable used during sign-in.' },
      {
        displayName: 'Model', name: 'model', type: 'string', default: '',
        displayOptions: { show: { '@version': [1] } },
        placeholder: 'gemini-3.8-flash-medium',
        description: 'Model ID from agy models. Leave empty to use the CLI default.',
      },
      {
        displayName: 'Model', name: 'model', type: 'resourceLocator',
        default: { mode: 'list', value: '' }, displayOptions: { show: { '@version': [2] } },
        description: 'Choose an available model or enter its ID manually. Empty uses the CLI default.',
        modes: [
          { displayName: 'From List', name: 'list', type: 'list', typeOptions: { searchListMethod: 'searchModels', searchable: true } },
          { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'gemini-3.8-flash-medium' },
        ],
      },
      {
        displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {},
        options: [
          { displayName: 'CLI Executable', name: 'executable', type: 'string', default: 'auto',
            description: 'Auto downloads and caches the compatible CLI. Or set an absolute path to your own executable.' },
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
    const selection = this.getNodeParameter('model', itemIndex, '') as string | { value: string };
    const model = typeof selection === 'string' ? selection : String(selection.value || '');
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
