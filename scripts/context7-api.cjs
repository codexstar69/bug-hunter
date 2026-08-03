#!/usr/bin/env node

const { context7Request } = require('./doc-lookup.cjs');

async function searchLibrary({ libraryName, query }) {
  return context7Request('/libs/search', {
    libraryName,
    query
  });
}

async function getContext({ libraryId, query }) {
  return context7Request('/context', {
    libraryId,
    query,
    type: 'json'
  });
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (command === 'search') {
    const [libraryName, ...queryParts] = args;
    const query = queryParts.join(' ');
    if (!libraryName || !query) {
      throw new Error('Usage: context7-api.cjs search <libraryName> <query>');
    }
    const result = await searchLibrary({ libraryName, query });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'context') {
    const [libraryId, ...queryParts] = args;
    const query = queryParts.join(' ');
    if (!libraryId || !query) {
      throw new Error('Usage: context7-api.cjs context <libraryId> <query>');
    }
    const result = await getContext({ libraryId, query });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error('Usage: context7-api.cjs <search|context> <args...>');
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  getContext,
  searchLibrary
};
