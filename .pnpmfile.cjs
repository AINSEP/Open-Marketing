// Jini UI/agentic/chat are written against zod 3 (they declare peer zod ^3.25.76); OM itself uses zod 4.
// A peer would resolve to OM's zod 4 and break their schemas, so give these packages their own zod 3.
const zod3Packages = new Set(['@jini-ai/ui', '@jini-ai/agentic', '@jini-ai/chat']);

function readPackage({ ...pkg }) {
  if (!zod3Packages.has(pkg.name)) return pkg;
  if (pkg.peerDependencies) delete pkg.peerDependencies.zod;
  if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.zod;
  pkg.dependencies = { ...pkg.dependencies, zod: '3.25.76' };
  return pkg;
}

module.exports = { hooks: { readPackage } };
