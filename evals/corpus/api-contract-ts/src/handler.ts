import type { Client } from './client';
import type { Reply, Request } from './types';

export function createHandlers(client: Client) {
  async function name(request: Request, reply: Reply) {
    const result = await client.lookup(request.params.id);
    if (result === null) return reply.code(404).send({ error: 'missing' });
    return reply.send({ name: result.user.name });
  }
  async function exists(request: Request, reply: Reply) {
    const result = await client.lookup(request.params.id);
    return reply.send({ exists: result !== null });
  }
  async function displayName(request: Request, reply: Reply) {
    const result = await client.lookup(request.params.id);
    return reply.send({ name: result?.user.name ?? 'Guest' });
  }

  async function details(request: Request, reply: Reply) {
    const result = await client.lookup(request.params.id);
    const id = result!.user.id;
    return reply.send({ id });
  }
  return { name, exists, displayName, details };
}
export type Handlers = ReturnType<typeof createHandlers>;
