'use strict';
/* Fill an EMPTY database with demo people and conversations, so a test instance
 * has something to look at without touching anyone's real messages.
 *
 *   DATA_DIR=data node scripts/seed-demo.js
 *
 * It refuses to run against a database that already has users, because the whole
 * point is that it can never be pointed at a live one by accident. Every account
 * shares the same obvious password, which is exactly why this belongs nowhere
 * near a real deployment.
 */
const DB = require('../lib/db');
const { hashPassword } = require('../lib/util');

const PASSWORD = 'demo12345';

if (DB.stmts.countUsers.get().n > 0) {
    console.error('This database already has users — refusing to seed it.');
    console.error('Point DATA_DIR at an empty directory and try again.');
    process.exit(1);
}

const mk = (username, displayName) => {
    const { salt, hash } = hashPassword(PASSWORD);
    const u = DB.createUser({ username, displayName, salt, hash });
    // Only the first account is active by default; the rest would sit pending,
    // and a demo where nobody can sign in demonstrates nothing.
    DB.stmts.setUserStatus.run('active', u.id);
    return DB.stmts.userById.get(u.id);
};

// The first account created becomes the admin — that is Ada here, so the admin
// panel has something to show.
const ada = mk('ada', 'Ada Lovelace');
const grace = mk('grace', 'Grace Hopper');
const alan = mk('alan', 'Alan Turing');
const katherine = mk('katherine', 'Katherine Johnson');
const pending = mk('newcomer', 'Hopeful Newcomer');
DB.stmts.setUserStatus.run('pending', pending.id);   // so approval can be tried

const say = (convId, from, content, opts = {}) =>
    DB.addMessage({ convId, senderId: from.id, type: 'text', content, ...opts });

/* ---- a direct conversation with a bit of everything ---- */
const direct = DB.getOrCreateDirect(ada.id, grace.id);
const opener = say(direct.id, grace, 'Morning! Did the overnight run finish?');
say(direct.id, ada, 'It did — 4,000 iterations, no crashes.', { replyTo: opener.id });
const q = say(direct.id, grace, 'Any idea what fixed it?');
say(direct.id, ada, 'The retry loop. It was giving up one attempt too early.', { replyTo: q.id });
const liked = say(direct.id, grace, 'Beautiful. I owe you a coffee.');
DB.stmts.addReaction.run(liked.id, ada.id, '👍', Date.now());

/* ---- right-to-left, so the Farsi layout can be checked at a glance ---- */
const rtl = DB.getOrCreateDirect(ada.id, alan.id);
say(rtl.id, alan, 'سلام! این یک پیام آزمایشی برای بررسی چیدمان راست‌به‌چپ است.');
say(rtl.id, ada, 'Looks right to me — and this English line should stay left-to-right.');
say(rtl.id, alan, 'خوبه. مرسی 🙏');

/* ---- a group, with the system events a real one accumulates ---- */
const group = DB.createGroup('Analytical Engine', ada.id, [grace.id, alan.id, katherine.id]);
DB.addMessage({
    convId: group.id, senderId: ada.id, type: 'system',
    content: `${ada.display_name} created the group`,
    sysKey: 'sys.group_created', sysArgs: { name: ada.display_name },
});
const plan = say(group.id, ada, 'Agenda for Thursday: the punch-card reader, then budgets.');
say(group.id, katherine, 'I can take the reader — I have the measurements already.', { replyTo: plan.id });
say(group.id, alan, 'Budgets will be short. We underspent again.');
const cheer = say(group.id, grace, 'Underspending is a kind of achievement 🎉');
for (const u of [ada, alan, katherine]) DB.stmts.addReaction.run(cheer.id, u.id, '😂', Date.now());

// A missed call and a completed one, so the activity bell and the call log both
// have something in them.
const missed = DB.addMessage({
    convId: group.id, senderId: alan.id, type: 'system',
    content: 'Missed voice call',
    sysKey: 'sys.call_missed_voice', sysArgs: { by: alan.id }, markRead: false,
});
const now = Date.now();
DB.addMessage({
    convId: group.id, senderId: ada.id, type: 'system',
    content: 'Video call · 12:41',
    sysKey: 'sys.call_video',
    sysArgs: { startedAt: now - 761_000, endedAt: now, seconds: 761 },
    markRead: false,
});
// Everyone but the caller, and pointing at the line in the thread so the bell
// item has somewhere to take you.
for (const u of [ada, grace, katherine]) {
    DB.stmts.insertActivity.run(u.id, 'missed_call', group.id, missed.id, alan.id, null, now);
}
// A reaction Ada has not seen either, so the bell shows more than one kind.
DB.stmts.insertActivity.run(ada.id, 'reaction', group.id, plan.id, katherine.id, '👍', now);
DB.stmts.addReaction.run(plan.id, katherine.id, '👍', now);

/* ---- unread on purpose, so the divider and the badge can be seen ---- */
const unread = DB.getOrCreateDirect(ada.id, katherine.id);
say(unread.id, ada, 'Sending the figures over now.');
say(unread.id, katherine, 'Got them, thank you.');
say(unread.id, katherine, 'One question though — is column D gross or net?');
say(unread.id, katherine, 'And should I use the revised exchange rate?');
say(unread.id, katherine, 'No rush, tomorrow is fine.');

console.log(`Seeded ${DB.stmts.countUsers.get().n} accounts.

  ada        Ada Lovelace       (admin)
  grace      Grace Hopper
  alan       Alan Turing
  katherine  Katherine Johnson
  newcomer   Hopeful Newcomer   (pending — approve them from the admin panel)

  password for all of them: ${PASSWORD}

Sign in as ada to see unread messages waiting, a group with reactions and call
history, and a right-to-left conversation.`);
