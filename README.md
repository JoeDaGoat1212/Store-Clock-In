# Concession Time Clock

A tablet-friendly time clock for the school concession stand. Employees clock in and out with a 4-digit PIN (or a student ID badge scanner), new employees can create their own account, and the manager screen shows hours, approvals and a CSV export for payroll.

## How it's built

- `public/index.html` — the whole page (keypad, boards, manager screen)
- `api/clock.js` — one Vercel serverless function; it checks every PIN on the server
- Data lives in a free **Upstash Redis** database connected through Vercel

## Deploy on Vercel

1. Go to vercel.com, sign in with GitHub, click **Add New → Project** and import this repository. Leave every setting at its default and click **Deploy**.
2. In the new project, open the **Storage** tab and click **Upstash for Redis** (or **Create Database → Upstash → Redis**). Pick the free plan and connect it to this project. Vercel adds the connection settings for you.
3. Open **Deployments**, click the **⋯** menu on the latest deployment, and choose **Redeploy** so the app picks up the database.
4. Open your `*.vercel.app` address. The status in the top corner should say **Online**.

## First-time setup

1. Tap **Manager** and enter `0000`.
2. In **Settings**, change the manager PIN right away. Use 6 digits, since the site is public.
3. Add employees on the **Employees** tab, or let them tap **Create account** on the keypad and approve them.

## Safety notes

- Employee PINs never go to the browser; the server checks them.
- After 8 wrong PINs in 15 minutes, a device is locked out for 15 minutes (separately for employee and manager PINs).
- Anyone with the link can see who is on the clock. Only the manager PIN unlocks hours and editing.
