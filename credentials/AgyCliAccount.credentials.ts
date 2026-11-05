import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class AgyCliAccount implements ICredentialType {
  name = 'agyCliAccount';
  displayName = 'Agy CLI Account';
  documentationUrl = 'https://github.com/artemYashin/n8n_agy_node#sign-in-inside-n8n';
  properties: INodeProperties[] = [
    { displayName: 'Use the Agy Account node to start Google sign-in, then paste the returned code below and complete sign-in. This connects the n8n server’s shared Agy account; credentials do not create separate Google accounts.', name: 'notice', type: 'notice', default: '' },
    { displayName: 'CLI Executable', name: 'executable', type: 'string', default: 'agy', required: true,
      description: 'Installed executable name or absolute path on the n8n server, without arguments' },
    { displayName: 'One-Time Authorization Code', name: 'authorizationCode', type: 'string', default: '',
      typeOptions: { password: true },
      description: 'Code or full callback URL from Google sign-in. Clear this field after successful sign-in. It is not needed for model requests.' },
  ];
}
