# My Tracker

An offline task and goal tracker for your Android phone. Your data stays on your phone only.

- **Tasks**: add, edit, tick done, due dates, priority, link to a goal, search
- **Goals**: long-term goals with progress based on their linked tasks
- **No delete**: items are *archived* or *cancelled* instead, and can be restored. Every change is kept in a permanent history log.
- **Stats**: completed tasks, completion rate, streaks, on-time rate, weekly chart, activity calendar, best day of the week, goal progress
- **Backup**: export to a file / share to Google Drive, import back (import only adds or updates, never removes)

## Files

| File | What it does |
|---|---|
| `index.html` | The page structure |
| `style.css` | How it looks (light and dark mode) |
| `app.js` | Everything the app does (commented section by section) |
| `manifest.json` | Name and icon used when installed on your phone |
| `sw.js` | Service worker: keeps a copy of the app on the phone so it works offline |
| `icons/` | App icons |

## Put it on your Android phone (one time, free)

The app has to be opened from a web address (https) once so Android can install it. GitHub Pages hosts it for free. Only the app's code goes online. **Your tasks never leave your phone.**

1. Create a free account at **github.com**.
2. Click **+ → New repository**. Name it `my-tracker`, set it to **Public**, click **Create repository**.
3. Click **uploading an existing file**. Drag in all the files from this folder, including the `icons` folder. Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Branch*, pick **main** and **/(root)**, then **Save**.
5. Wait 1–2 minutes. Your app is at `https://YOUR-USERNAME.github.io/my-tracker/`
6. Open that address in **Chrome on your phone**. Tap **⋮ → Install app** (or *Add to Home screen*).
7. Open it from the home screen icon. To check offline mode, turn on airplane mode and open it again.

## Keep your data safe (important for long-term use)

- Your data is stored inside Chrome on your phone. Uninstalling the app or clearing Chrome's site data **erases it**.
- Go to **More → Share backup** every week or two and save the file to Google Drive. The app reminds you after 14 days.
- New phone? Install the app, then **More → Import backup**.

## Changing the app later

1. Edit the files, then open `sw.js` and change `VERSION = 'v1'` to `'v2'` (and so on each time).
2. Upload the changed files to GitHub again.
3. Close and reopen the app on your phone (sometimes twice) to get the new version. Your data is not affected.

To try changes on your computer first: install the **Live Server** extension in VS Code, right-click `index.html` → *Open with Live Server*. (Double-clicking the file won't work because browsers block storage for files opened directly.)
