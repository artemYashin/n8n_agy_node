const { ApiError } = require('./completions.cjs');
const { verificationError } = require('./bridge.ts');

function seconds(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?[hms])+$/.test(value)) return;
  let total = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) total += Number(match[1]) * {h:3600,m:60,s:1}[match[2]];
  return total > 0 && total <= 30 * 86400 ? Math.ceil(total) : undefined;
}

// Classify errors from the image tool, never expose raw CLI logs or prompts.
function imageToolError(diagnostic) {
  const verification = verificationError(diagnostic);
  if (verification) return verification;
  let upstream;
  try { upstream = JSON.parse(diagnostic.slice(diagnostic.indexOf('{'))).error; } catch {}
  const details = Array.isArray(upstream?.details) ? upstream.details : [];
  const quota = /QUOTA_EXHAUSTED|quota.{0,30}(?:exhausted|exceeded)|exhausted your capacity/i.test(diagnostic);
  if (quota || upstream?.code === 429 || /\b429\b|RESOURCE_EXHAUSTED|Too Many Requests/i.test(diagnostic)) {
    let retryAfter;
    for (const detail of details) {
      retryAfter = seconds(detail.retryDelay) || seconds(detail.metadata?.quotaResetDelay);
      if (retryAfter) break;
    }
    retryAfter ||= seconds(diagnostic.match(/reset after\s+([\dhms.]+)/i)?.[1]);
    const message = quota ? 'The Google account has exhausted its image-generation quota.' : 'The image-generation service is rate limited.';
    const error = new ApiError(429, message + (retryAfter ? ` Retry after approximately ${retryAfter} seconds.` : ' Wait before retrying.'), null, quota ? 'image_quota_exceeded' : 'image_rate_limit_exceeded');
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
  }
  return new ApiError(502, 'Agy’s image-generation tool failed. No image was returned. Check account access or try again later.', null, 'image_generation_failed');
}
module.exports = { imageToolError };
