const baseUrl = require('../baseUrl');

const subscribe = (z, bundle) =>
  z
    .request({
      url: `${baseUrl(bundle)}/api/v1/hooks`,
      method: 'POST',
      body: { url: bundle.targetUrl, events: ['member.created'] },
    })
    .then((res) => res.data.hook);

const unsubscribe = (z, bundle) =>
  z
    .request({
      url: `${baseUrl(bundle)}/api/v1/hooks/${bundle.subscribeData.id}`,
      method: 'DELETE',
    })
    .then((res) => res.data);

// The webhook body is the envelope; Zapier wants the resource.
const perform = (z, bundle) => [
  { id: bundle.cleanedRequest.data.member_id, ...bundle.cleanedRequest.data },
];

// Populates sample data while the user is building the Zap.
const performList = (z, bundle) =>
  z
    .request({ url: `${baseUrl(bundle)}/api/v1/members?limit=3` })
    .then((res) => res.data.members.map((m) => ({ ...m, member_id: m.id })));

module.exports = {
  key: 'newMember',
  noun: 'Member',
  display: {
    label: 'New Member',
    description: 'Triggers when a member is created.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribe,
    performUnsubscribe: unsubscribe,
    perform,
    performList,
    sample: require('../fixtures/member.created.json').data,
  },
};
