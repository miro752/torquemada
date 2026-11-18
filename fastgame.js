/**
 * Rejeu rapide de parties (sans le moteur) : sert à valider les imports
 * et à chercher une position dans de grosses bases.
 * Numérotation : case n = bit (n-1). Les blancs montent (promotion sur 29-32),
 * les noirs descendent (promotion sur 1-4).
 */

const RC = new Array(33);      // case -> [ligne, colonne]
const SQ = {};                 // "l,c" -> case
for (let sq = 1; sq <= 32; sq++) {
    const idx = sq - 1;
    const boardRow = Math.floor(idx / 4), pos = idx % 4;
    const col = boardRow % 2 === 0 ? 7 - 2 * pos : 6 - 2 * pos;
    RC[sq] = [boardRow, col];
    SQ[boardRow * 8 + col] = sq;
}

export const INITIAL = Object.freeze({ white: 0x00000FFF, black: 0xFFF00000, kings: 0, wtm: true });

export function hashPos(p) {
    let h = Math.imul((p.white ^ 0x9e3779b9) | 0, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h ^ p.black, 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h ^ p.kings, 0x27d4eb2f);
    h ^= h >>> 15;
    h = Math.imul(h ^ (p.wtm ? 1 : 2), 0x165667b1);
    return (h ^ (h >>> 16)) >>> 0;
}

export function posFromBoard(b) {
    return { white: b.white >>> 0, black: b.black >>> 0, kings: b.kings >>> 0, wtm: !!b.whiteToMove };
}

/** Applique un coup écrit "9-13" ou "22x13x4". Renvoie la nouvelle position, ou null si incohérent. */
export function applyNotation(p, notation) {
    const sqs = notation.split(/[-x]/);
    if (sqs.length < 2) return null;
    const cap = notation.indexOf('x') >= 0;
    let white = p.white, black = p.black, kings = p.kings;
    const mine = p.wtm ? white : black;
    const from = parseInt(sqs[0], 10);
    if (!(from >= 1 && from <= 32)) return null;
    const fbit = (1 << (from - 1)) >>> 0;
    if (!(mine & fbit)) return null;
    const isKing = (kings & fbit) !== 0;
    // on soulève la pièce
    if (p.wtm) white = (white & ~fbit) >>> 0; else black = (black & ~fbit) >>> 0;
    kings = (kings & ~fbit) >>> 0;
    let cur = from;
    for (let i = 1; i < sqs.length; i++) {
        const to = parseInt(sqs[i], 10);
        if (!(to >= 1 && to <= 32)) return null;
        const tbit = (1 << (to - 1)) >>> 0;
        if ((white | black) & tbit) return null;
        {
            const [r0, c0] = RC[cur], [r1, c1] = RC[to];
            const dr = Math.sign(r1 - r0), dc = Math.sign(c1 - c0);
            if (Math.abs(r1 - r0) !== Math.abs(c1 - c0) || dr === 0) return null;
            let r = r0 + dr, c = c0 + dc, found = 0;
            while (r !== r1 || c !== c1) {
                const s = SQ[r * 8 + c];
                const b = (1 << (s - 1)) >>> 0;
                if (white & b || black & b) {
                    const enemy = p.wtm ? (black & b) : (white & b);
                    if (!enemy || found) return null;
                    found = b;
                }
                r += dr; c += dc;
            }
            if (cap && !found) return null;
            if (found) {
                if (p.wtm) black = (black & ~found) >>> 0; else white = (white & ~found) >>> 0;
                kings = (kings & ~found) >>> 0;
            }
        }
        cur = to;
    }
    const lbit = (1 << (cur - 1)) >>> 0;
    if (p.wtm) white = (white | lbit) >>> 0; else black = (black | lbit) >>> 0;
    const promo = p.wtm ? cur >= 29 : cur <= 4;
    if (isKing || promo) kings = (kings | lbit) >>> 0;
    return { white, black, kings, wtm: !p.wtm };
}

/** Rejoue une liste de coups. Renvoie { ok, count, keys (Uint32Array), pos } ; count = coups valides. */
export function replayMoves(start, moves) {
    let p = start || INITIAL;
    const keys = new Uint32Array(moves.length + 1);
    keys[0] = hashPos(p);
    let n = 0;
    for (; n < moves.length; n++) {
        const q = applyNotation(p, moves[n]);
        if (!q) break;
        p = q;
        keys[n + 1] = hashPos(p);
    }
    return { ok: n === moves.length, count: n, keys: n === moves.length ? keys : keys.slice(0, n + 1), pos: p };
}

export function startPosOf(game) {
    return game.start ? { white: game.start.white >>> 0, black: game.start.black >>> 0, kings: game.start.kings >>> 0, wtm: !!game.start.whiteToMove } : INITIAL;
}
