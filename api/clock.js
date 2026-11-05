// Concession Time Clock API — one Vercel serverless function backed by Upstash Redis (REST).
// Every request is a POST with JSON { a: "<action>", ... }.
import crypto from "node:crypto";

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const P = "tc:";                // key prefix
const DEFAULT_PIN = "0000";
const UNDO_MS = 2 * 60 * 1000;
const MAX_FAILS = 8;            // per IP per 15 minutes
const FAIL_WINDOW_S = 15 * 60;

/* ---------- database ---------- */
async function pipe(cmds) {
  const r = await fetch(DB_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + DB_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("db " + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const parseHash = a => {
  const o = {};
  for (let i = 0; i < (a || []).length; i += 2) { try { o[a[i]] = JSON.parse(a[i + 1]); } catch {} }
  return o;
};
async function load() {
  const [s, e, h] = await pipe([["GET", P + "settings"], ["HGETALL", P + "emp"], ["HGETALL", P + "shift"]]);
  const settings = { storeName: "Concession Stand", managerPin: DEFAULT_PIN, requireApproval: true, sound: true, ...(s ? JSON.parse(s) : {}) };
  return { settings, emp: parseHash(e), shift: parseHash(h) };
}
const putEmp = e => ["HSET", P + "emp", e.id, JSON.stringify(e)];
const putShift = s => ["HSET", P + "shift", s.id, JSON.stringify(s)];
const newId = () => crypto.randomBytes(9).toString("base64url");

/* ---------- rate limiting ---------- */
const ipOf = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
const failKey = (req, kind) => P + "fail:" + kind + ":" + ipOf(req);
async function limited(req, kind) { const [n] = await pipe([["GET", failKey(req, kind)]]); return Number(n || 0) >= MAX_FAILS; }
async function strike(req, kind) { const k = failKey(req, kind); await pipe([["INCR", k], ["EXPIRE", k, FAIL_WINDOW_S]]); }
async function clearStrikes(req, kind) { await pipe([["DEL", failKey(req, kind)]]); }

/* ---------- helpers ---------- */
const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const isListed = e => e.active !== false;            // live or pending: holds its PIN
const pinTaken = (d, pin, except) => pin === d.settings.managerPin || Object.values(d.emp).some(e => e.id !== except && isListed(e) && e.pin === pin);
const badgeTaken = (d, b, except) => !!b && Object.values(d.emp).some(e => e.id !== except && isListed(e) && e.badge && e.badge.toLowerCase() === b.toLowerCase());
const nameOf = (d, s) => (d.emp[s.empId] || {}).name || s.name || "Former employee";
const weekMs = (d, empId, ws, now) => Object.values(d.shift).filter(s => s.empId === empId && s.in >= ws).reduce((t, s) => t + ((s.out || now) - s.in), 0);
const adminView = d => ({
  settings: { storeName: d.settings.storeName, requireApproval: d.settings.requireApproval !== false, sound: d.settings.sound !== false, defaultPin: d.settings.managerPin === DEFAULT_PIN },
  employees: Object.values(d.emp),
  shifts: Object.values(d.shift).map(({ undoKey, undoUntil, undoType, ...s }) => s),
});
const fail = (code, error) => ({ code, error });

/* ---------- manager actions ---------- */
async function adminOp(d, b, now) {
  const E = d.emp[b.id], S = d.shift[b.id];
  switch (b.op) {
    case "data": return;
    case "addEmp": {
      const name = clean(b.name, 40), pin = clean(b.pin, 4), badge = clean(b.badge, 40);
      if (!name) return fail(400, "Enter a name.");
      if (!/^\d{4}$/.test(pin)) return fail(400, "PIN must be exactly 4 digits.");
      if (pinTaken(d, pin)) return fail(409, "PIN " + pin + " is already in use.");
      if (badgeTaken(d, badge)) return fail(409, "That badge code is already in use.");
      const e = { id: newId(), name, pin, badge, active: true, pending: false, createdAt: now };
      d.emp[e.id] = e; await pipe([putEmp(e)]); return;
    }
    case "editEmp": {
      if (!E) return fail(404, "Employee not found.");
      const name = clean(b.name, 40), pin = clean(b.pin, 4), badge = clean(b.badge, 40);
      if (!name) return fail(400, "Enter a name.");
      if (!/^\d{4}$/.test(pin)) return fail(400, "PIN must be 4 digits.");
      if (pinTaken(d, pin, E.id)) return fail(409, "That PIN is taken.");
      if (badgeTaken(d, badge, E.id)) return fail(409, "Badge code in use.");
      Object.assign(E, { name, pin, badge }); await pipe([putEmp(E)]); return;
    }
    case "approve": if (!E) return fail(404, "Employee not found."); E.pending = false; await pipe([putEmp(E)]); return;
    case "deny": if (!E) return; delete d.emp[E.id]; await pipe([["HDEL", P + "emp", E.id]]); return;
    case "remove": if (!E) return; E.active = false; await pipe([putEmp(E)]); return;
    case "restore":
      if (!E) return;
      if (pinTaken(d, E.pin, E.id)) return fail(409, "Someone else has PIN " + E.pin + " now. Add " + E.name + " again with a new PIN.");
      E.active = true; await pipe([putEmp(E)]); return;
    case "clockOut": if (!S || S.out) return; S.out = now; await pipe([putShift(S)]); return;
    case "allOut": {
      const open = Object.values(d.shift).filter(s => !s.out);
      open.forEach(s => { s.out = now; });
      if (open.length) await pipe(open.map(putShift)); return;
    }
    case "editShift": {
      if (!S) return fail(404, "Shift not found.");
      const tin = Number(b.in), tout = b.out == null ? null : Number(b.out);
      if (!tin || (tout !== null && !(tout > tin))) return fail(400, "Out must be after in.");
      S.in = tin; S.out = tout; await pipe([putShift(S)]); return;
    }
    case "deleteShift": if (!S) return; delete d.shift[S.id]; await pipe([["HDEL", P + "shift", S.id]]); return;
    case "addShift": {
      const emp = d.emp[b.empId];
      const tin = Number(b.in), tout = Number(b.out);
      if (!emp) return fail(400, "Pick an employee.");
      if (!tin || !(tout > tin)) return fail(400, "Out time must be after the in time.");
      const s = { id: newId(), empId: emp.id, name: emp.name, in: tin, out: tout, manual: true };
      d.shift[s.id] = s; await pipe([putShift(s)]); return;
    }
    case "settings": {
      const st = { ...d.settings };
      if (b.storeName != null) { const v = clean(b.storeName, 40); if (v) st.storeName = v; }
      if (b.managerPin != null) {
        const v = clean(b.managerPin, 6);
        if (!/^\d{4,6}$/.test(v)) return fail(400, "Manager PIN must be 4 to 6 digits.");
        if (Object.values(d.emp).some(e => isListed(e) && e.pin === v)) return fail(409, "An employee already uses that PIN.");
        st.managerPin = v;
      }
      if (typeof b.requireApproval === "boolean") st.requireApproval = b.requireApproval;
      if (typeof b.sound === "boolean") st.sound = b.sound;
      d.settings = st; await pipe([["SET", P + "settings", JSON.stringify(st)]]); return;
    }
    default: return fail(400, "Unknown action.");
  }
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const send = (code, obj) => res.status(code).json(obj);
  if (req.method !== "POST") return send(405, { error: "Use POST." });
  if (!DB_URL || !DB_TOKEN) return send(500, { error: "Database not connected. In Vercel, add Upstash Redis to this project and redeploy." });
  let b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b || "{}"); } catch { return send(400, { error: "Bad request." }); } }

  try {
    const d = await load();
    const now = Date.now();

    switch (b.a) {
      case "board": {
        const since = Number(b.since) || now - 86400000;
        const sh = Object.values(d.shift);
        return send(200, {
          storeName: d.settings.storeName,
          requireApproval: d.settings.requireApproval !== false,
          sound: d.settings.sound !== false,
          pendingCount: Object.values(d.emp).filter(e => isListed(e) && e.pending).length,
          open: sh.filter(s => !s.out).map(s => ({ name: nameOf(d, s), in: s.in })),
          today: sh.filter(s => s.out && s.in >= since).map(s => ({ name: nameOf(d, s), in: s.in, out: s.out })),
        });
      }

      case "punch": {
        if (await limited(req, "pin")) return send(429, { error: "Too many wrong tries. Wait 15 minutes or ask your manager." });
        const c = clean(b.code, 40);
        const emp = c && Object.values(d.emp).find(e => isListed(e) && (e.pin === c || (e.badge && e.badge.toLowerCase() === c.toLowerCase())));
        if (!emp) { await strike(req, "pin"); return send(404, { error: "No account has that PIN. Try again, or tap Create account if you're new." }); }
        if (emp.pending) return send(200, { status: "pending", name: emp.name });
        const ws = Number(b.weekStart) || now - 7 * 864e5;
        const undoKey = newId();
        const open = Object.values(d.shift).find(s => s.empId === emp.id && !s.out);
        if (open) {
          Object.assign(open, { out: now, undoKey, undoUntil: now + UNDO_MS, undoType: "out" });
          await pipe([putShift(open)]);
          return send(200, { status: "out", name: emp.name, in: open.in, out: now, id: open.id, undoKey, weekMs: weekMs(d, emp.id, ws, now) });
        }
        const s = { id: newId(), empId: emp.id, name: emp.name, in: now, out: null, undoKey, undoUntil: now + UNDO_MS, undoType: "in" };
        d.shift[s.id] = s;
        await pipe([putShift(s)]);
        return send(200, { status: "in", name: emp.name, in: now, id: s.id, undoKey, weekMs: weekMs(d, emp.id, ws, now) });
      }

      case "undo": {
        const s = d.shift[b.id];
        if (!s || !b.key || s.undoKey !== b.key || now > s.undoUntil) return send(400, { error: "Too late to undo. Ask your manager to fix it." });
        if (s.undoType === "in") await pipe([["HDEL", P + "shift", s.id]]);
        else { s.out = null; delete s.undoKey; delete s.undoUntil; delete s.undoType; await pipe([putShift(s)]); }
        return send(200, { ok: true });
      }

      case "signup": {
        if (await limited(req, "signup")) return send(429, { error: "Too many new accounts from this device. Try again later." });
        const name = clean(b.name, 40), pin = clean(b.pin, 4), badge = clean(b.badge, 40);
        if (name.length < 2) return send(400, { error: "Enter your name." });
        if (!/^\d{4}$/.test(pin)) return send(400, { error: "Your PIN must be exactly 4 numbers." });
        if (pinTaken(d, pin)) { await strike(req, "signup"); return send(409, { error: "That PIN is already taken. Pick a different one." }); }
        if (badgeTaken(d, badge)) return send(409, { error: "That student ID is already linked to an account." });
        const pending = d.settings.requireApproval !== false;
        const e = { id: newId(), name, pin, badge, active: true, pending, selfSignup: true, createdAt: now };
        await pipe([putEmp(e)]);
        await strike(req, "signup");
        return send(200, { ok: true, pending, name });
      }

      case "login":
      case "admin": {
        if (await limited(req, "mgr")) return send(429, { error: "Too many wrong manager PINs. Wait 15 minutes." });
        if (clean(b.pin, 6) !== d.settings.managerPin) { await strike(req, "mgr"); return send(401, { error: "That isn't the manager PIN." }); }
        if (b.a === "login") { await clearStrikes(req, "mgr"); return send(200, adminView(d)); }
        const r = await adminOp(d, b, now);
        if (r && r.error) return send(r.code || 400, { error: r.error });
        return send(200, adminView(d));
      }

      default: return send(400, { error: "Unknown action." });
    }
  } catch (err) {
    console.error(err);
    return send(500, { error: "Server error. Try again in a moment." });
  }
}
