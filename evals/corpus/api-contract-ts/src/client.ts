import type { User, UserResult } from './types';
export function createClient(users: Map<string, User>) {
  return {
    async lookup(id: string): Promise<UserResult> {
      const user = users.get(id);
      return user ? { user } : null;
    }
  };
}
export type Client = ReturnType<typeof createClient>;
