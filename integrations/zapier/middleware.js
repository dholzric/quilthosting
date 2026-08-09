/**
 * Attaches the API key to every outbound request.
 *
 * This lives here rather than as an `authentication.befores` property — that
 * shape is rejected by the v17 schema ("additionalProperty befores exists in
 * instance when not allowed"). beforeRequest on the app export is the
 * supported hook.
 */
const addApiKey = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.apiKey) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  }
  return request;
};

module.exports = { addApiKey };
