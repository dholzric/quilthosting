const baseUrl = require('../baseUrl');

const subscribe = (z, bundle) =>
  z
    .request({
      url: `${baseUrl(bundle)}/api/v1/hooks`,
      method: 'POST',
      body: { url: bundle.targetUrl, events: ['event.registration'] },
    })
    .then((res) => res.data.hook);

const unsubscribe = (z, bundle) =>
  z
    .request({
      url: `${baseUrl(bundle)}/api/v1/hooks/${bundle.subscribeData.id}`,
      method: 'DELETE',
    })
    .then((res) => res.data);

const perform = (z, bundle) => [
  { id: bundle.cleanedRequest.data.registration_id, ...bundle.cleanedRequest.data },
];

/**
 * There is no GET /api/v1/registrations yet (master program Phase 2). Listing
 * /api/v1/events here instead would hand Zapier event fields — title, start_at —
 * where registration fields belong, and the user would map the wrong data.
 * Returning the fixture keeps field discovery correct until the endpoint lands.
 */
const performList = () => [require('../fixtures/event.registration.json').data];

module.exports = {
  key: 'eventRegistration',
  noun: 'Registration',
  display: {
    label: 'New Event Registration',
    description:
      'Triggers when someone takes an event seat — free, waitlist, or paid.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribe,
    performUnsubscribe: unsubscribe,
    perform,
    performList,
    sample: require('../fixtures/event.registration.json').data,
  },
};
