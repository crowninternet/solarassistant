# 🔄 Data Restore Instructions
## Complete Step-by-Step Guide for Beginners

This guide will walk you through restoring your Solar Dashboard data from a backup. No prior technical knowledge required!

---

## 📋 When to Use This Guide

Restore your data if:
- Your data files got corrupted
- You accidentally deleted important data
- You need to go back to a previous state
- Something went wrong and you want to undo changes

---

## 🚀 Step-by-Step Restore Process

### Step 1: Open Terminal

**On Mac:**
1. Press `Command (⌘) + Space` to open Spotlight Search
2. Type: `Terminal`
3. Press `Enter`

A window with a black or white background will open. This is the Terminal.

---

### Step 2: Navigate to the App Directory

In the Terminal window, type this **exact** command and press `Enter`:

```bash
cd /Users/jmahon/Documents/Battery
```

**What this does:** Changes your location to the Solar Dashboard folder.

**You should see:** The Terminal prompt will now show something ending in `Battery`.

---

### Step 3: Run the Restore Command

Type this command and press `Enter`:

```bash
npm run restore
```

**What this does:** Starts the restore process.

---

### Step 4: View Available Backups

You will see a list like this:

```
📦 Available Backups:

1. 10/10/2025, 2:48:38 PM (v7.1.0) - 3 files
2. 10/9/2025, 2:00:15 AM (v7.1.0) - 3 files
3. 10/8/2025, 2:00:12 AM (v7.1.0) - 3 files

Enter backup number to restore (or "q" to quit):
```

**What this means:**
- Each numbered line is a backup
- The date/time shows when the backup was created
- Backup #1 is the most recent (newest)
- Higher numbers are older backups

---

### Step 5: Choose a Backup

**To restore the most recent backup:**
- Type: `1`
- Press `Enter`

**To restore an older backup:**
- Type the number of the backup you want (like `2` or `3`)
- Press `Enter`

**To cancel without restoring:**
- Type: `q`
- Press `Enter`

---

### Step 6: Wait for Restore to Complete

You will see messages like:

```
🔄 Restoring backup from 10/10/2025, 2:48:38 PM...

💾 Creating safety backup of current files...
  ✓ Saved current alert_settings.json
  ✓ Saved current daily_stats.json
  ✓ Saved current data_history.json
  ✓ Saved current .env

📥 Restoring data files...
✅ Restored alert_settings.json (0.44 KB)
✅ Restored daily_stats.json (0.50 KB)
✅ Restored data_history.json (150.59 KB)

🔐 Restoring sensitive configuration...
🔑 Restored .env (0.65 KB) - Contains API keys!

🎉 Restore completed successfully!
📊 Data files restored: 3
🔐 Sensitive files restored: 1

🔑 API keys and sensitive configuration have been restored!
```

**This means:** Your data AND authentication credentials have been successfully restored!

**What's Restored:**
- ✅ Data files (alerts, stats, history)
- ✅ **Login credentials** (username & password)
- ✅ **JWT authentication settings**
- ✅ **API keys** (SendGrid, IFTTT)

**Important Note:** Your current files were automatically backed up before restoring, so nothing was lost.

---

### Step 7: Restart the Application

**CRITICAL STEP:** You must restart the Solar Dashboard for the restored data to take effect.

In the Terminal, type this command and press `Enter`:

```bash
pm2 restart solar-dashboard
```

**You should see:** A table showing the Solar Dashboard is now running with status "online".

---

### Step 8: Verify Everything Works

1. Open your web browser (Safari, Chrome, Firefox, etc.)
2. Go to: `http://localhost:3434`
3. **You'll be redirected to the login page** (authentication is enabled)
4. **Login with the credentials from the restored backup:**
   - The restored `.env` file contains the username and password
   - If you don't remember them, check `backups/backup_[timestamp]/.env`
5. After login, check that your dashboard loads correctly
6. Verify your data looks correct

**If everything looks good:** You're done! ✅

⚠️ **Important:** The restored backup includes the login credentials that were active when the backup was created. If you changed your password after the backup, you'll need to use the OLD password from the backup.

---

## 🎯 Quick Reference Card

**Copy and paste these commands one at a time:**

```bash
# 1. Go to app directory
cd /Users/jmahon/Documents/Battery

# 2. Start restore process
npm run restore

# 3. Choose backup number when prompted (e.g., type "1" and press Enter)

# 4. Restart the application
pm2 restart solar-dashboard
```

---

## 🚨 Troubleshooting

### Problem: "command not found: npm"

**Solution:**
1. Close Terminal
2. Open a new Terminal window
3. Try the commands again

### Problem: "No such file or directory"

**Solution:** You're in the wrong folder. Make sure you typed the `cd` command exactly:
```bash
cd /Users/jmahon/Documents/Battery
```

### Problem: "No backups found"

**Solution:** No backups exist yet. You need to create a backup first:
```bash
npm run backup
```

### Problem: Dashboard won't load after restore

**Solution:**
1. Make sure you restarted the app: `pm2 restart solar-dashboard`
2. Wait 10 seconds and refresh your browser
3. Check if the app is running: `pm2 status`

### Problem: "Cannot read properties of undefined"

**Solution:** The backup might be corrupted. Try restoring an older backup (use number 2 or 3 instead of 1).

---

## 📞 Emergency Recovery

If something goes terribly wrong and you can't restore:

### Your Current Files Were Backed Up!

Before every restore, your current files are automatically saved. To find them:

1. Open Finder
2. Go to: `/Users/jmahon/Documents/Battery/backups/`
3. Look for folders starting with `before_restore_`
4. These contain your files from just before the restore

### To Manually Copy Files Back

If you need to manually restore files:

1. Open Finder
2. Navigate to: `/Users/jmahon/Documents/Battery/backups/`
3. Find the backup folder you want
4. Copy the `.json` files from the backup folder
5. Paste them into: `/Users/jmahon/Documents/Battery/`
6. When asked to replace files, click "Replace"
7. Restart: `pm2 restart solar-dashboard`

---

## 💡 Pro Tips

### Tip 1: Restore Before Making Big Changes
Before upgrading or changing settings, create a backup:
```bash
cd /Users/jmahon/Documents/Battery
npm run backup
```

### Tip 2: Keep Notes
When you make important changes, write down:
- The date and time
- What you changed
- Why you changed it

This helps you know which backup to restore if needed.

### Tip 3: Test Your Backups
Once a month, try restoring the most recent backup to make sure backups are working.

### Tip 4: Quick Restore (No Prompts)
To restore the latest backup without being asked:
```bash
node restore.js 1
```

---

## 📁 File Locations

All backups are stored here:
```
/Users/jmahon/Documents/Battery/backups/
```

To view backups in Finder:
1. Open Finder
2. Press `Command (⌘) + Shift + G`
3. Paste: `/Users/jmahon/Documents/Battery/backups/`
4. Press `Enter`

---

## ✅ Checklist

After a restore, verify:

- [ ] Restore completed without errors
- [ ] Application was restarted (`pm2 restart solar-dashboard`)
- [ ] Dashboard loads in browser (`http://localhost:3434`)
- [ ] Data looks correct
- [ ] Alerts are working (if you use them)
- [ ] Charts show historical data

---

## 📚 Additional Resources

- **Backup Guide:** See `BACKUP_GUIDE.md` for advanced backup options
- **Check App Status:** `pm2 status`
- **View App Logs:** `pm2 logs solar-dashboard`
- **Stop App:** `pm2 stop solar-dashboard`
- **Start App:** `pm2 start solar-dashboard`

---

## 🆘 Still Need Help?

If you're stuck:

1. **Check the logs:**
   ```bash
   cd /Users/jmahon/Documents/Battery
   pm2 logs solar-dashboard --lines 50
   ```

2. **Verify app is running:**
   ```bash
   pm2 status
   ```

3. **Take a screenshot** of any error messages

4. **Document what you did** step by step

---

**Created:** October 10, 2025  
**Version:** 7.1.0  
**Last Updated:** October 10, 2025

---

## 🎓 Understanding the Commands

### `cd` command
- **Stands for:** Change Directory
- **What it does:** Moves you to a different folder
- **Example:** `cd /Users/jmahon/Documents/Battery` goes to the Battery folder

### `npm run restore` command
- **What it does:** Runs the restore program
- **Needs:** You must be in the Battery folder first

### `pm2 restart` command
- **What it does:** Restarts the Solar Dashboard application
- **Why needed:** The app needs to reload to use the restored data

### `pm2 status` command
- **What it does:** Shows if the Solar Dashboard is running
- **Look for:** Status should say "online"

---

**Remember:** When in doubt, you can always quit (type `q` and press Enter) and start over!

