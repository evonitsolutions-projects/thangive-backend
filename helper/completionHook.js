// helper/completionHook.js
//
// P3b — the shared, idempotent "an order just became fully COMPLETED"
// handler for the order-ownership rollout.
//
// Call sites (every path in transactionController.js that can make
// rm_status = am_status = st_status = 'COMPLETED'):
//   1. addUpdateOrder   — advisor-2 SELL pre-insert synthetic BUY (inserted
//                          already COMPLETED). No-ops here (is_excluded).
//   2. addUpdateOrder   — Mark-as-Sold SELL with advisor 2 (inserted already
//                          COMPLETED). No-ops here (is_excluded).
//   3. addUpdateOrder   — normal BUY with advisor 2 (inserted already
//                          COMPLETED). No-ops here (is_excluded).
//   4. addUpdateOrder   — the main INSERT/UPDATE path in general (covers any
//                          other case that happens to already be COMPLETED).
//   5. updateOrderStatus — RM approves a Thangive mark-as-sold (sets all
//                          three to COMPLETED in one UPDATE). No-ops here
//                          (is_excluded, since markAsSold=1).
//   6. updateOrderStatus — normal RM/AM/ST stage progression, whichever
//                          branch is the one that completes the order.
// All six are covered by calling this function UNCONDITIONALLY after every
// INSERT/UPDATE of order_transactions in those two handlers — the function
// itself decides whether there is anything to do.
//
// IDEMPOTENCY: guarded by `revenue_rm_id IS NULL` for the revenue/ownership
// writes. Calling this twice for the same already-processed order is a
// guaranteed no-op (verified in testing). See helper/withTransaction.js's
// header comment for why idempotency matters here (the main status UPDATE
// commits on a different, non-transactional connection before this hook's
// own transaction opens).
//
// SCOPE — deliberately NOT done here (per the plan, D-04/D-05/D-08a):
//   - rm_status / am_status / st_status are NEVER read for write, only for
//     the one all-COMPLETED check.
//   - Invoices, commissions, share-debit numbers: untouched (owned by the
//     existing DB triggers).
//   - Advisor-2 and mark-as-sold orders: do NOT get revenue_rm_id,
//     users.assign_to, or users.assign_partner touched AT ALL — this is an
//     intentional behavior change from the old inline code that used to run
//     at transactionController.js:512-529, which wrote assign_partner for
//     ANY fully-completed order with addedPartnerID set, with no advisor-2 /
//     mark-as-sold exclusion. D-05 explicitly excludes them.

import withTransaction from './withTransaction.js';

const EXCLUDED_REASON = 'advisor-2 or mark-as-sold order: excluded from revenue/ownership writes (D-05)';

/**
 * @param {number|string} orderId
 * @param {number|string} actorId - the acting user's id (for changed_by on history rows)
 * @returns {Promise<{ ran: boolean, reason?: string }>}
 */
export async function onOrderFullyCompleted(orderId, actorId) {
    const id = Number(orderId);
    const actor = Number(actorId) || 0;
    if (!Number.isInteger(id) || id <= 0) {
        return { ran: false, reason: 'invalid order id' };
    }

    return withTransaction(async (tx) => {
        const rows = await tx.getData(
            `SELECT order_id, user_id, transaction_type, advisor_id, markAsSold, addedPartnerID,
                    owner_rm_id, revenue_rm_id, origin_type, rm_status, am_status, st_status, created_at
               FROM order_transactions
              WHERE order_id = ${id}
              FOR UPDATE`
        );
        if (!rows || !rows.length) return { ran: false, reason: 'order not found' };
        const o = rows[0];

        const allCompleted = o.rm_status === 'COMPLETED' && o.am_status === 'COMPLETED' && o.st_status === 'COMPLETED';
        if (!allCompleted) return { ran: false, reason: 'not fully completed yet' };

        const isExcluded =
            (o.transaction_type === 'BUY' && Number(o.advisor_id) === 2) ||
            (o.transaction_type === 'SELL' && Number(o.markAsSold || 0) === 1);
        if (isExcluded) return { ran: false, reason: EXCLUDED_REASON };

        // Idempotency: once revenue_rm_id is set, this order has already been processed.
        if (o.revenue_rm_id != null) return { ran: false, reason: 'already processed (revenue_rm_id set)' };

        // --- revenue lock (only when there IS an owner to credit) ---
        if (o.owner_rm_id != null) {
            await tx.insertData(
                `UPDATE order_transactions
                    SET revenue_rm_id = ?, revenue_locked_at = NOW()
                  WHERE order_id = ? AND revenue_rm_id IS NULL`,
                [o.owner_rm_id, id]
            );
            await tx.insertData(
                `INSERT INTO order_owner_history
                    (order_id, previous_owner_rm_id, new_owner_rm_id,
                     previous_revenue_rm_id, new_revenue_rm_id, reason, changed_by)
                 VALUES (?, ?, ?, NULL, ?, 'COMPLETE', ?)`,
                [id, o.owner_rm_id, o.owner_rm_id, o.owner_rm_id, actor]
            );
        }

        // --- partner-origin assign_to flip (D-03/D-04) ---
        const isPartnerOrigin = o.origin_type === 'PARTNER_RM_VERIFIED' || o.origin_type === 'PARTNER_ON_BEHALF';
        if (isPartnerOrigin && o.owner_rm_id != null) {
            const adminOverride = await tx.getData(
                `SELECT 1 AS hit FROM user_rm_assignment_history
                  WHERE user_id = ${Number(o.user_id)}
                    AND reason = 'ADMIN_MANUAL'
                    AND changed_at > '${new Date(o.created_at).toISOString().slice(0, 19).replace('T', ' ')}'
                  LIMIT 1`
            );
            if (!adminOverride || !adminOverride.length) {
                const userRows = await tx.getData(
                    `SELECT assign_to FROM users WHERE user_id = ${Number(o.user_id)} FOR UPDATE`
                );
                const prevRm = userRows && userRows.length ? userRows[0].assign_to : null;
                if (prevRm == null || Number(prevRm) !== Number(o.owner_rm_id)) {
                    await tx.insertData(`UPDATE users SET assign_to = ? WHERE user_id = ?`, [o.owner_rm_id, o.user_id]);
                    await tx.insertData(
                        `INSERT INTO user_rm_assignment_history
                            (user_id, previous_rm_id, new_rm_id, changed_by, reason, order_id)
                         VALUES (?, ?, ?, ?, 'ORDER_COMPLETION_PARTNER_FLIP', ?)`,
                        [o.user_id, prevRm, o.owner_rm_id, actor, id]
                    );
                }
            }
        }

        // --- assign_partner (independent of origin_type, matches the old
        //     code's own condition — just gated by "not excluded", already
        //     guaranteed above) ---
        if (o.addedPartnerID != null) {
            const userRows2 = await tx.getData(
                `SELECT assign_partner FROM users WHERE user_id = ${Number(o.user_id)} FOR UPDATE`
            );
            const prevPartner = userRows2 && userRows2.length ? userRows2[0].assign_partner : null;
            if (prevPartner == null || Number(prevPartner) !== Number(o.addedPartnerID)) {
                await tx.insertData(`UPDATE users SET assign_partner = ? WHERE user_id = ?`, [o.addedPartnerID, o.user_id]);
                await tx.insertData(
                    `INSERT INTO user_partner_association_history
                        (user_id, previous_partner_id, new_partner_id, changed_by, reason, order_id)
                     VALUES (?, ?, ?, ?, 'ORDER_COMPLETION', ?)`,
                    [o.user_id, prevPartner, o.addedPartnerID, actor, id]
                );
            }
        }

        return { ran: true };
    });
}

export default { onOrderFullyCompleted };
