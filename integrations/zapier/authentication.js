const baseUrl = require('./baseUrl');

/**
 * bundle.authData holds what the user typed plus whatever `test` returns, so
 * the tenant name has to come back from the test call — referencing
 * {{bundle.authData.tenantName}} directly would render an empty label.
 */
module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      required: true,
      type: 'password',
      helpText:
        'In QuiltHosting: Admin → API → Create key. Tick **hooks:write** (required ' +
        'even for trigger-only Zaps) and **members:write** if you want the Create ' +
        'Member action. The key is shown once — copy it before leaving the page.',
    },
    {
      key: 'baseUrl',
      label: 'Site URL',
      required: false,
      type: 'string',
      default: 'https://quilthosting.com',
      helpText: 'Leave as-is unless you were given a different URL.',
    },
  ],
  test: async (z, bundle) => {
    const res = await z.request({ url: `${baseUrl(bundle)}/api/v1/me` });
    if (res.status !== 200) {
      throw new Error('That API key was not accepted.');
    }
    return {
      tenantName: res.data.tenant.name,
      tenantId: res.data.tenant.id,
      scopes: res.data.scopes,
    };
  },
  connectionLabel: '{{tenantName}}',
};
