#!/usr/bin/env node
if (process.argv[2] === 'models') {
  console.log('test-model\tTest Model');
} else if (process.argv[2] === 'acp' && process.argv[3] === '--login') {
  const url = 'https://accounts.google.com/o/oauth2/auth?response_type=code&code_challenge_method=S256&code_challenge=TEST_CHALLENGE&state=TEST_STATE';
  process.stdout.write('Open this link:\n' + url.slice(0, 75));
  setTimeout(() => process.stdout.write(url.slice(75) + '\nPaste code:\n'), 20);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    if (input.trim() === 'valid-code') {
      console.log('Signed in. private-token-MUST-NOT-LEAK');
    } else {
      console.error('Rejected code ' + input + ' private-token-MUST-NOT-LEAK');
      process.exitCode = 1;
    }
  });
} else {
  process.exitCode = 1;
}
