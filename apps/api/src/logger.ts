import crypto from 'crypto';
import { db } from './db.js';

export type LogEvent = {
  id: string;
  created_at: string;
  type: string;
  scope?: string | null;
  message: string;
  payload?: any;
};

export function logEvent(event: { type: string; scope?: string | null; message: string; payload?: any }) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO event_log (id, created_at, type, scope, message, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, now, event.type, event.scope ?? null, event.message, event.payload ? JSON.stringify(event.payload) : null);
}

export function listLog(limit = 200): LogEvent[] {
  const rows = db
    .prepare('SELECT * FROM event_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<any>;
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    type: r.type,
    scope: r.scope,
    message: r.message,
    payload: r.payload ? JSON.parse(r.payload) : undefined,
  }));
}

