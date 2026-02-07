import { db } from './db.js';

export function listRaw(limit = 200) {
  const rows = db
    .prepare(
      `SELECT rt.id,
              rt.created_at AS createdAt,
              rt.booking_date AS bookingDate,
              rt.amount,
              rt.currency,
              rt.data,
              isess.source_bank AS sourceBank,
              isess.format
       FROM raw_transactions rt
       JOIN import_sessions isess ON isess.id = rt.import_session_id
       ORDER BY rt.created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<any>;

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    bookingDate: r.bookingDate,
    amount: r.amount,
    currency: r.currency,
    data: JSON.parse(r.data),
    sourceBank: r.sourceBank,
    format: r.format,
  }));
}
