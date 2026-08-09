/**
 * Every request goes through here rather than hardcoding the production host.
 * Without it, testing against a preview URL or a local tunnel means forking
 * the app — which is painful while the product is still gated.
 */
module.exports = (bundle) =>
  (bundle.authData && bundle.authData.baseUrl) || 'https://quilthosting.com';
