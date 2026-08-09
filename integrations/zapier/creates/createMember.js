const baseUrl = require('../baseUrl');
const crypto = require('crypto');

module.exports = {
  key: 'createMember',
  noun: 'Member',
  display: {
    label: 'Create Member',
    description: 'Creates a member in your guild.',
  },
  operation: {
    inputFields: [
      { key: 'email', label: 'Email', required: true, type: 'string' },
      { key: 'first_name', label: 'First Name', type: 'string' },
      { key: 'last_name', label: 'Last Name', type: 'string' },
      { key: 'phone', label: 'Phone', type: 'string' },
      {
        key: 'status',
        label: 'Status',
        type: 'string',
        choices: ['pending', 'active'],
        default: 'pending',
        helpText:
          'Setting "active" consumes a slot against the free plan limit of 30 ' +
          'active members.',
      },
    ],
    perform: (z, bundle) => {
      // Zapier retries on timeout. Without a stable key per task, a retry would
      // hit the duplicate-email guard and report failure for a member that was
      // in fact created. bundle.meta.id is stable across retries of the same
      // task; the hash is a fallback for contexts where it is absent.
      const idempotencyKey =
        (bundle.meta && bundle.meta.id) ||
        crypto
          .createHash('sha256')
          .update(JSON.stringify(bundle.inputData))
          .digest('hex')
          .slice(0, 32);

      return z
        .request({
          url: `${baseUrl(bundle)}/api/v1/members`,
          method: 'POST',
          headers: { 'Idempotency-Key': `zap-${idempotencyKey}` },
          body: {
            email: bundle.inputData.email,
            first_name: bundle.inputData.first_name,
            last_name: bundle.inputData.last_name,
            phone: bundle.inputData.phone,
            status: bundle.inputData.status,
          },
        })
        .then((res) => res.data.member);
    },
    sample: {
      id: 'mem_sample',
      email: 'member@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      status: 'pending',
    },
  },
};
