export type User = { id: string; name: string };
export type UserResult = { user: User } | null;
export type Reply = { code(status: number): Reply; send(body: unknown): unknown };
export type Request = { params: { id: string } };
