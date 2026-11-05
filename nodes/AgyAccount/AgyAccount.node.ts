import { NodeConnectionTypes, type INodeType, type INodeTypeDescription, type IExecuteFunctions, type INodeExecutionData } from 'n8n-workflow';
import { startLogin, completeLogin, cancelLogin, checkConnection } from './auth.js';
import { resolveExecutable } from '../shared/runtime.js';

export class AgyAccount implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Agy Account', name: 'agyAccount', icon: 'file:agy-account.svg', group: ['transform'], version: 1,
    description: 'Sign in to Agy with Google from n8n', defaults: { name: 'Agy Account' },
    inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'agyCliAccount', required: true }],
    properties: [
      { displayName: 'Setup only: run this node manually. Start sign-in, open the link in its output, paste the Google code into your credential, then complete sign-in. This changes the shared Agy account on this server.', name: 'notice', type: 'notice', default: '' },
      { displayName: 'Operation', name: 'operation', type: 'options', default: 'startLogin', noDataExpression: true,
        options: [
          { name: 'Install CLI', value: 'installCli', action: 'Install Agy CLI', description: 'Download and verify the compatible CLI, or show the configured executable' },
          { name: 'Start Sign-In', value: 'startLogin', action: 'Start Google sign-in', description: 'Get a Google authorization link, valid for up to 10 minutes' },
          { name: 'Complete Sign-In', value: 'completeLogin', action: 'Complete Google sign-in', description: 'Submit the code saved in the selected credential' },
          { name: 'Check Connection', value: 'checkConnection', action: 'Check Agy connection', description: 'Verify that Agy can list available models' },
          { name: 'Cancel Sign-In', value: 'cancelLogin', action: 'Cancel pending sign-in', description: 'Cancel the pending login without signing out the existing account' },
        ] },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    if (this.getMode() !== 'manual') throw new Error('Agy Account is a manual setup node. Run it from the n8n editor.');
    const credential = await this.getCredentials('agyCliAccount');
    const owner = this.getNode().credentials?.agyCliAccount?.id;
    if (!owner) throw new Error('Save and select an Agy CLI Account credential first.');
    const executable = String(credential.executable || 'agy');
    const operation = this.getNodeParameter('operation', 0) as string;
    switch (operation) {
      case 'installCli':
        return [[{ json: { executable: await resolveExecutable(executable), status: 'ready' } }]];
      case 'startLogin': {
        const login = await startLogin(owner, executable);
        return [[{ json: { ...login, status: 'awaitingSignIn', instructions: 'Open authorizationUrl, sign in with Google, paste the returned code or callback URL into the One-Time Authorization Code field in your selected credential, save it, then run Complete Sign-In. Keep using the same n8n process.' } }]];
      }
      case 'completeLogin':
        await completeLogin(owner, executable, String(credential.authorizationCode || ''));
        return [[{ json: { status: 'signedIn', instructions: 'Clear One-Time Authorization Code in the credential and save. Select this credential in Agy Chat Model using Authentication → Agy CLI Account.' } }]];
      case 'checkConnection':
        return [[{ json: await checkConnection(executable) }]];
      case 'cancelLogin':
        return [[{ json: { cancelled: cancelLogin(owner) } }]];
      default: throw new Error('Unknown Agy Account operation.');
    }
  }
}
