// helper/ownership.js
//
// P3a — Order-wise ownership (write-side only).
//
// WHAT THIS FILE PROVIDES
//   - getActor(userId)             : reads users.user_type from DB (JWT role is unreliable, BACKEND-NOTES §5).
//   - getClientAssignTo(userId)    : reads users.assign_to for a client (used for SELF owner rule).
//   - pickOwnerRm({actor, body, clientUser}) : resolves origin_type + owner_rm_id per plan §0A D-01/D-05/D-06.
//   - deriveOriginType(actor, body)          : fallback derivation when the client omits origin_type.
//
// WHAT IT DOES NOT DO (P3a scope)
//   - Does NOT read or write any history table.
//   - Does NOT touch users.assign_to / users.assign_partner.
//   - Does NOT fire the completion hook.
//   - Does NOT change any read query, dashboard, report or refund guard.
//   Those are P3b / P4 work.

import { getData } from '../config/index.js';

const VALID_ORIGINS = ['SELF', 'RM_DIRECT', 'PARTNER_RM_VERIFIED', 'PARTNER_ON_BEHALF', 'ADMIN'];
// SYSTEM_BACKFILL is the only other enum value; it is reserved for the
// 015 backfill migration and must NEVER be accepted from the API.

const VALID_LEAD_TYPES = ['partner_stock_order'];

/** Read the authenticated actor from the users table. JWT role is NOT trusted here. */
async function getActor(userId, next) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const rows = await getData(
        `SELECT user_id, user_type
           FROM users
          WHERE user_id = ${id} AND is_deleted = 0
          LIMIT 1`,
        next
    );
    return rows && rows.length ? rows[0] : null;
}

/** Read the client user's current RM assignment (used by SELF owner rule). */
async function getClientAssignTo(userId, next) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const rows = await getData(
        `SELECT user_id, assign_to, user_type
           FROM users
          WHERE user_id = ${id} AND is_deleted = 0
          LIMIT 1`,
        next
    );
    return rows && rows.length ? rows[0] : null;
}

/**
 * Derive origin_type from the actor role and body shape when the client
 * omits it. Returns null for actor roles that MUST send it explicitly.
 */
function deriveOriginType(actor, body) {
    if (!actor) return null;
    const hasPartner = Number(body?.addedPartnerID || 0) > 0;
    if (actor.user_type === 'RM') return hasPartner ? 'PARTNER_RM_VERIFIED' : 'RM_DIRECT';
    if (actor.user_type === 'user') return 'SELF';
    // ADMIN / SM / PARTNER / AM / ST must send origin_type explicitly.
    return null;
}

/**
 * Pick the owner_rm_id (and resolved origin_type) for a NEW order.
 *
 * Inputs:
 *   actor       - {user_id, user_type} from getActor(req.user._id)
 *   body        - the request body (dataObj in addUpdateOrder)
 *   clientUser  - {user_id, assign_to, user_type} from getClientAssignTo(body.user_id)
 *
 * Returns one of:
 *   { owner_rm_id, origin_type, derived }   - success. derived=true when origin_type came from the fallback path.
 *   { error }                               - a CustomErrorHandler.* instance to pass to next(err).
 *
 * Rules (plan §0A D-01 / D-05 / D-06):
 *   - RM creating an order -> owner = actor
 *   - Partner-lead or on-behalf order -> owner = acting RM (same as RM_DIRECT)
 *   - User self-order -> owner = clientUser.assign_to at this moment (NULL if unassigned)
 *   - ADMIN/SM order -> owner = body.owner_rm_id (required, rejected if missing)
 *   - PARTNER / AM / ST are not expected to hit /buyStock directly; rejected unless the caller supplies origin_type explicitly.
 */
async function pickOwnerRm({ actor, body, clientUser }, CustomErrorHandler) {
    if (!actor) {
        return { error: CustomErrorHandler.badRequest('Ownership: actor could not be resolved') };
    }

    // Resolve origin_type (take from body, else derive).
    let origin_type = body?.origin_type;
    let derived = false;

    if (origin_type && !VALID_ORIGINS.includes(origin_type)) {
        return { error: CustomErrorHandler.badRequest(`Ownership: invalid origin_type '${origin_type}'`) };
    }

    if (!origin_type) {
        origin_type = deriveOriginType(actor, body);
        if (!origin_type) {
            return {
                error: CustomErrorHandler.badRequest(
                    `Ownership: origin_type is required for actor role '${actor.user_type}'`
                ),
            };
        }
        derived = true;
        // Log so the ops team can watch for legacy clients.
        // eslint-disable-next-line no-console
        console.warn(
            `[ownership] derived origin_type=${origin_type} actor_id=${actor.user_id} role=${actor.user_type} partner=${body?.addedPartnerID || 'none'}`
        );
    }

    // Resolve owner_rm_id per origin_type.
    switch (origin_type) {
        case 'RM_DIRECT': {
            if (actor.user_type !== 'RM') {
                return { error: CustomErrorHandler.badRequest('Ownership: RM_DIRECT requires an RM actor') };
            }
            return { owner_rm_id: Number(actor.user_id), origin_type, derived };
        }
        case 'PARTNER_RM_VERIFIED':
        case 'PARTNER_ON_BEHALF': {
            if (actor.user_type !== 'RM') {
                return { error: CustomErrorHandler.badRequest(`Ownership: ${origin_type} requires an RM actor`) };
            }
            if (!Number(body?.addedPartnerID)) {
                return { error: CustomErrorHandler.badRequest(`Ownership: ${origin_type} requires addedPartnerID`) };
            }
            return { owner_rm_id: Number(actor.user_id), origin_type, derived };
        }
        case 'SELF': {
            if (actor.user_type !== 'user') {
                return { error: CustomErrorHandler.badRequest('Ownership: SELF requires a user actor') };
            }
            // D-06: owner may legitimately be NULL for an unassigned client.
            const ownerCurrent = clientUser?.assign_to;
            const ownerInt = ownerCurrent != null ? Number(ownerCurrent) : null;
            return { owner_rm_id: Number.isInteger(ownerInt) && ownerInt > 0 ? ownerInt : null, origin_type, derived };
        }
        case 'ADMIN': {
            if (actor.user_type !== 'ADMIN' && actor.user_type !== 'SM') {
                return { error: CustomErrorHandler.badRequest('Ownership: ADMIN origin requires ADMIN/SM actor') };
            }
            const explicit = Number(body?.owner_rm_id);
            if (!Number.isInteger(explicit) || explicit <= 0) {
                return { error: CustomErrorHandler.badRequest('Ownership: ADMIN origin requires owner_rm_id in the request body') };
            }
            return { owner_rm_id: explicit, origin_type, derived };
        }
        default:
            return { error: CustomErrorHandler.badRequest(`Ownership: unhandled origin_type '${origin_type}'`) };
    }
}

/** Validate the (origin_lead_type, origin_lead_id) pair. Returns null on OK or an error instance. */
function validateLead(body, CustomErrorHandler) {
    const t = body?.origin_lead_type;
    const id = body?.origin_lead_id;
    if (t == null && id == null) return null; // both omitted — fine
    if (t != null && !VALID_LEAD_TYPES.includes(t)) {
        return CustomErrorHandler.badRequest(`Ownership: invalid origin_lead_type '${t}'`);
    }
    if ((t != null) !== (id != null)) {
        return CustomErrorHandler.badRequest('Ownership: origin_lead_type and origin_lead_id must be sent together');
    }
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) {
        return CustomErrorHandler.badRequest('Ownership: origin_lead_id must be a positive integer');
    }
    return null;
}

export default {
    getActor,
    getClientAssignTo,
    pickOwnerRm,
    deriveOriginType,
    validateLead,
    VALID_ORIGINS,
    VALID_LEAD_TYPES,
};
