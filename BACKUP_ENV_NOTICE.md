# 🔐 Important: Backup System Now Includes .env File

## Overview

The backup and restore system has been updated to include your `.env` file, which contains sensitive API keys and configuration.

---

## ✅ What Changed

### Backup Script (`backup.js`)

**Now backs up:**
- ✅ `alert_settings.json` - User preferences
- ✅ `daily_stats.json` - Daily statistics
- ✅ `data_history.json` - Historical data
- ✅ **`.env` - Sensitive configuration including:** ⭐ NEW
  - **JWT authentication credentials** (JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH)
  - **API keys** (SendGrid, IFTTT)
  - **MQTT broker configuration**

### Restore Script (`restore.js`)

**Now restores:**
- ✅ All data files
- ✅ **`.env` file with:** ⭐ NEW
  - **JWT authentication credentials** (login username & password)
  - **API keys** (SendGrid, IFTTT)
  - **All configuration settings**
- ✅ Creates safety backup of current files (including `.env`) before restoring

---

## 🔐 Security Implications

### Critical Security Information

**⚠️ WARNING:** Your backups now contain sensitive credentials!

```
backups/
├── backup_2025-10-10T22-10-57/
│   ├── alert_settings.json
│   ├── daily_stats.json
│   ├── data_history.json
│   ├── .env                    ← Contains LOGIN CREDENTIALS + API KEYS!
│   │                              • JWT_SECRET
│   │                              • ADMIN_USERNAME
│   │                              • ADMIN_PASSWORD_HASH
│   │                              • SendGrid API Key
│   │                              • IFTTT Webhook Key
│   └── backup_info.json
```

### What This Means

1. **Backups are more valuable** - They now include everything needed for complete recovery
2. **Backups are HIGHLY sensitive** - They contain your login credentials and API keys
3. **No manual reconfiguration needed** - Restoring a backup restores everything automatically
4. **Password recovery is easy** - If you forget your password, restore a recent backup

---

## 🛡️ Security Best Practices

### DO:

✅ **Protect backup directory:**
```bash
chmod 700 /Users/jmahon/Documents/Battery/backups
```

✅ **Store backups securely:**
- Use encrypted external drives
- Use encrypted cloud storage (with 2FA)
- Never store in public/shared locations

✅ **Limit access:**
```bash
# Make .env readable only by owner
chmod 600 /Users/jmahon/Documents/Battery/.env
```

✅ **Regular backups:**
- Automated daily backups at 2 AM via PM2
- Manual backups before major changes: `npm run backup`

### DON'T:

❌ **Never commit backups to git** - `.gitignore` already excludes them
❌ **Never share backup folders** - They contain your API keys
❌ **Never store in Dropbox/Google Drive** without encryption
❌ **Never email backup folders** - Highly insecure

---

## 📋 Backup Process

### When You Run `npm run backup`

```
✅ Backed up alert_settings.json (0.44 KB)
✅ Backed up daily_stats.json (0.52 KB)
✅ Backed up data_history.json (160.42 KB)

🔐 Backing up sensitive configuration...
🔑 Backed up .env (0.37 KB) - Contains API keys!

🎉 Backup completed successfully!
📂 Location: /Users/jmahon/Documents/Battery/backups/backup_2025-10-10T22-10-57
📊 Data files backed up: 3
🔐 Sensitive files backed up: 1

⚠️  SECURITY WARNING:
   This backup contains sensitive API keys (.env file)
   Store this backup securely and never commit to version control!
```

### Backup Metadata

The `backup_info.json` now includes:

```json
{
  "timestamp": "2025-10-10T22:10:57.962Z",
  "files": [
    "alert_settings.json",
    "daily_stats.json",
    "data_history.json",
    ".env"
  ],
  "version": "7.1.0",
  "backedUpCount": 3,
  "sensitiveCount": 1,
  "skippedCount": 0,
  "containsSensitiveData": true
}
```

---

## 🔄 Restore Process

### When You Run `npm run restore`

```
📦 Available Backups:

1. 10/10/2025, 3:10:57 PM (v7.1.0) - 3 files
2. 10/10/2025, 3:09:20 PM (v7.1.0) - 3 files

Enter backup number to restore (or "q" to quit): 1

🔄 Restoring backup from 10/10/2025, 3:10:57 PM...

💾 Creating safety backup of current files...
  ✓ Saved current alert_settings.json
  ✓ Saved current daily_stats.json
  ✓ Saved current data_history.json
  ✓ Saved current .env              ← Your current API keys saved!

📥 Restoring data files...
✅ Restored alert_settings.json (0.44 KB)
✅ Restored daily_stats.json (0.52 KB)
✅ Restored data_history.json (160.42 KB)

🔐 Restoring sensitive configuration...
🔑 Restored .env (0.37 KB) - Contains API keys!

🎉 Restore completed successfully!
📊 Data files restored: 3
🔐 Sensitive files restored: 1

🔑 API keys and sensitive configuration have been restored!

⚠️  Remember to restart the application: pm2 restart solar-dashboard
```

### Safety Features

1. **Before-restore backup** - Your current files (including `.env`) are saved before any restore
2. **Located at:** `backups/before_restore_[timestamp]/`
3. **Includes:** All data files AND `.env` file
4. **Allows rollback** if restore didn't work as expected

---

## 🚨 Disaster Recovery

### Scenario 1: Lost .env File

**With new backup system:**
```bash
npm run restore
# Select most recent backup
# Your .env file is restored with all API keys!
pm2 restart solar-dashboard
```

**Without backup (old system):**
- ❌ Would need to manually recreate .env
- ❌ Would need to find/recreate all API keys
- ❌ Significant downtime

### Scenario 2: Corrupted Configuration

**With safety backup:**
```bash
# If restore goes wrong, your old .env is saved at:
# backups/before_restore_[timestamp]/.env

# Copy it back:
cp backups/before_restore_*//.env .env
pm2 restart solar-dashboard
```

### Scenario 3: System Migration

**Moving to new server:**
```bash
# On old server:
npm run backup

# Copy backup folder to new server securely:
scp -r backups/backup_2025-10-10T22-10-57 user@newserver:/path/

# On new server:
cd /path/to/app
mkdir -p backups
mv /path/backup_2025-10-10T22-10-57 backups/
npm run restore
# Select the backup
pm2 start app.js --name "solar-dashboard"
```

---

## 📊 Backup Retention

- **Keeps:** Last 30 backups automatically
- **Each backup contains:** All data + `.env` file
- **Storage:** Approximately 160 KB per backup (mostly historical data)
- **Total space:** ~5 MB for 30 backups

---

## 🔍 Verification

### Check if .env is in backups:

```bash
ls -la /Users/jmahon/Documents/Battery/backups/backup_*/
```

Look for `.env` file in each backup folder.

### Verify backup contains correct API keys:

```bash
# Check latest backup (DO NOT share this output!)
cat /Users/jmahon/Documents/Battery/backups/backup_$(ls -t backups | grep backup_ | head -1)/.env
```

### Test restore (safe):

```bash
# This creates a safety backup of current files before restoring
node restore.js 1
```

---

## 🔄 Migration from Old Backups

### Old Backups (Before .env Support)

Backups created before this update:
- ✅ Still contain `alert_settings.json` with OLD hardcoded API keys
- ❌ Do NOT contain `.env` file
- ⚠️ Restoring old backup will NOT restore `.env`

### What Happens When Restoring Old Backup:

```
🔐 Restoring sensitive configuration...
⚠️  .env not found in backup (you may need to configure manually)
```

**Solution:** Your current `.env` file is preserved (saved in before_restore backup), so your API keys remain intact.

---

## 💡 Pro Tips

### Tip 1: Backup Before Key Rotation

When rotating API keys:
```bash
# 1. Create backup with old keys
npm run backup

# 2. Update .env with new keys
nano .env

# 3. Test application
pm2 restart solar-dashboard

# 4. If new keys don't work, restore old backup
npm run restore
```

### Tip 2: Export for Off-Site Storage

```bash
# Create encrypted archive
tar -czf solar-backup-$(date +%Y%m%d).tar.gz backups/backup_$(ls -t backups | grep backup_ | head -1)

# Encrypt (requires gpg)
gpg --symmetric --cipher-algo AES256 solar-backup-*.tar.gz

# Now safe to store in cloud (still be careful!)
```

### Tip 3: Automated Encrypted Backups

Consider setting up automated encrypted backups to external storage:
- Use `rclone` with encryption
- Use `restic` for encrypted backups
- Use cloud provider encryption (AWS S3 with KMS, etc.)

---

## 📚 Related Documentation

- **Main Backup Guide:** `BACKUP_GUIDE.md`
- **Restore Instructions:** `RESTORE.md`
- **Security Migration:** `SECURITY_MIGRATION.md`

---

## ✅ Testing Checklist

After environment variable migration, verify:

- [ ] Run backup: `npm run backup`
- [ ] Check backup includes .env: `ls -la backups/backup_*/`
- [ ] Verify security warning appears in backup output
- [ ] Test restore: `node restore.js 1`
- [ ] Verify .env file restored correctly
- [ ] Check application still works: `pm2 status`
- [ ] Test API endpoints: `curl http://localhost:3434/data`
- [ ] Verify API keys work (check for alerts/MQTT)

---

**Created:** October 10, 2025  
**Version:** 7.1.0  
**Status:** ✅ Implemented and Tested

