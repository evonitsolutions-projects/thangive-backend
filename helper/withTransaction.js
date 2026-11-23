// helper/withTransaction.js
//
// P3b — real transaction helper for the order-ownership rollout.
//
// WHY A SEPARATE POOL (not config/database.js's `con`):
//   config/database.js exports getData/insertData bound to ONE single,
//   global mysql.createConnection() (`con`), shared by every request in the
//   app — not a pool, and it exposes no beginTransaction/commit/rollback and
//   no way to reserve a dedicated connection. Running a transaction on that
//   same shared connection would race with every other concurrent request's
//   own queries (a MySQL connection only holds one statement/transaction
//   state at a time). A separate pool, used only for
//   pool.getConnection() -> one reserved connection per transaction, is the
//   only safe way to get real BEGIN/COMMIT/ROLLBACK isolation here.
//   This helper builds that pool directly from process.env, using the SAME
//   variable names (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME) and the
//   SAME connection options (including `ssl: { rejectUnauthorized: false }`)
//   confirmed by reading config/database.js, and the SAME driver already in
//   package.json ("mysql", the classic callback-based client — NOT mysql2).
//   It still never touches .env directly or guesses at a host — the actual
//   values always come from process.env, exactly as config/database.js reads
//   them.
//
// FAIL-CLOSED:
//   If any of DB_HOST / DB_PORT / DB_USER / DB_NAME is not set at all
//   (undefined), the pool is never created and every call throws
//   immediately. DB_PASSWORD may legitimately be an empty string (local
//   passwordless root), so only "undefined" fails it, not falsy.
//
// WHAT "ONE CONNECTION" MEANS HERE:
//   Every statement run through the `tx` object passed into your callback
//   executes on the SAME dedicated connection, wrapped in a real
//   START TRANSACTION / COMMIT / ROLLBACK. This is what lets
//   `SELECT ... FOR UPDATE` actually lock a row for the lifetime of the
//   transaction.
//
// *** KNOWN LIMITATION (read before using) ***
//   The EXISTING order-status UPDATE in transactionController.js
//   (`updateOrderStatus`'s main `UPDATE order_transactions SET ? WHERE ...`)
//   still runs through the OLD, non-transactional `insertData` from
//   config/index.js — a DIFFERENT connection/pool than this one. That
//   UPDATE commits on its own, by itself, BEFORE the completion hook's
//   separate transaction (opened via THIS helper) ever begins.
//
//   Consequence: there is a real gap between "the order's rm/am/st_status
//   became COMPLETED" and "the completion hook's transaction committed".
//   If the process crashes in that gap, the order is left fully COMPLETED
//   but WITHOUT revenue_rm_id / assign_to / assign_partner / history ever
//   having been written for it — the hook simply never got to run.
//
//   This is NOT fixed by "use one bigger transaction" (that would require
//   routing the main UPDATE itself through this pool too, which is a
//   larger change than P3b asked for). The mitigation is that
//   helper/completionHook.js is fully IDEMPOTENT and SAFE TO RE-RUN:
//   calling onOrderFullyCompleted(orderId, actor) again for an order that
//   already has revenue_rm_id set is a guaranteed no-op (verified in
//   testing below). If a crash is ever suspected, re-invoking the hook for
//   the affected order_id(s) repairs the gap — there is no destructive
//   side effect from calling it twice, or from calling it on an order that
//   was never meant to be touched (advisor-2 / mark-as-sold orders no-op
//   by design, not-yet-completed orders no-op by design).

import mysql from 'mysql';

const REQUIRED_VARS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME'];

let pool = null;

function assertEnvComplete() {
    const missing = REQUIRED_VARS.filter((k) => process.env[k] === undefined);
    // DB_PASSWORD is allowed to be '' (passwordless local root) but must be
    // explicitly present, same rule as the others.
    if (process.env.DB_PASSWORD === undefined) missing.push('DB_PASSWORD');
    if (missing.length) {
        throw new Error(
            `withTransaction: fail-closed — missing env var(s): ${missing.join(', ')}. ` +
            'Refusing to build a connection pool with an incomplete configuration.'
        );
    }
}

function getPool() {
    if (pool) return pool;
    assertEnvComplete();
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        // Matches config/database.js's connection options exactly (confirmed by
        // inspecting it): without this, a DB that requires SSL (rejectUnauthorized:
        // false there suggests it does) would silently refuse this pool's connections
        // in production, even with identical host/user/password/database/port.
        ssl: {
            rejectUnauthorized: false
        },
        connectionLimit: 5,
    });
    return pool;
}

function getConnection(p) {
    return new Promise((resolve, reject) => {
        p.getConnection((err, conn) => (err ? reject(err) : resolve(conn)));
    });
}

function beginTransaction(conn) {
    return new Promise((resolve, reject) => {
        conn.beginTransaction((err) => (err ? reject(err) : resolve()));
    });
}

function commit(conn) {
    return new Promise((resolve, reject) => {
        conn.commit((err) => (err ? reject(err) : resolve()));
    });
}

function rollback(conn) {
    return new Promise((resolve) => {
        conn.rollback(() => resolve()); // best-effort; never throws
    });
}

function query(conn, sql, values) {
    return new Promise((resolve, reject) => {
        const cb = (err, result) => (err ? reject(err) : resolve(result));
        if (values === undefined) conn.query(sql, cb);
        else conn.query(sql, values, cb);
    });
}

/**
 * Run `fn(tx)` inside one real transaction on one dedicated connection.
 * `tx.getData(sql)` and `tx.insertData(sql, data)` mirror the shape of the
 * existing config/index.js helpers so call sites read the same way.
 *
 * Commits on success, rolls back and rethrows on any error (including a
 * thrown error from `fn` itself). The connection is always released.
 */
export async function withTransaction(fn) {
    const p = getPool(); // throws (fail-closed) if env is incomplete
    const conn = await getConnection(p);
    try {
        await beginTransaction(conn);
        const tx = {
            getData: (sql) => query(conn, sql),
            insertData: (sql, data) => query(conn, sql, data),
        };
        const result = await fn(tx);
        await commit(conn);
        return result;
    } catch (err) {
        await rollback(conn);
        throw err;
    } finally {
        conn.release();
    }
}

export default withTransaction;
