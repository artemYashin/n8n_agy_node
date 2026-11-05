// Only expose Google verification links, never arbitrary CLI diagnostics.
export function verificationError(diagnostic: string): (Error & { code: string; verification_url?: string }) | undefined {
  if (!/(?:validation_required|verification[_ ]required|verification_url|verify\s+your\s+(?:account|identity)|account\s+verification)/i.test(diagnostic)) return;
  const decoded = diagnostic.replace(/\\u003[dD]/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  let verification_url: string | undefined;
  for (const match of decoded.matchAll(/https:\/\/[^\s<>"'\\]+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ''));
      if (['accounts.google.com', 'myaccount.google.com'].includes(url.hostname) && !url.username && !url.password && !url.port) {
        verification_url = url.href;
        break;
      }
    } catch { /* Ignore malformed links. */ }
  }
  return Object.assign(new Error('Google account verification is required. Complete verification in your browser, then retry the request.'), {
    code: 'account_verification_required', ...(verification_url ? { verification_url } : {}),
  });
}
