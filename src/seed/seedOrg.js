// Σε κάθε νέα εγγραφή γραφείου: γεμίζει όλα τα lookup tables + δικαστήρια
const { seedCourts } = require('./courts');
const { seedLookups } = require('./lookups');

async function seedNewOrganization(client, organizationId) {
  await seedLookups(client, organizationId);
  await seedCourts(client, organizationId);
}

module.exports = { seedNewOrganization };
