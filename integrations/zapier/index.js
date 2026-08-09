const authentication = require('./authentication');
const { addApiKey } = require('./middleware');
const newMember = require('./triggers/newMember');
const eventRegistration = require('./triggers/eventRegistration');
const createMember = require('./creates/createMember');

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [addApiKey],
  triggers: {
    [newMember.key]: newMember,
    [eventRegistration.key]: eventRegistration,
  },
  creates: {
    [createMember.key]: createMember,
  },
};
