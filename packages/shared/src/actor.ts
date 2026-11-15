// Who makes a change, as the client names it (docs/adr/0001-actor-without-authentication.md).
// The web UI sends nothing and is recorded as `user`; the MCP server sends its
// configured actor (e.g. `hermes`) on every request.

export const ACTOR_HEADER = 'x-finance-actor';
export const ACTOR_PATTERN = /^[a-z0-9_-]{1,40}$/;
