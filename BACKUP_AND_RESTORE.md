# 🔄 Backup and Restore Guide

Complete guide for backing up and restoring your SolarAssistant Dashboard data, including authentication credentials and API keys.

---

## 📋 Overview

The backup system protects your critical data files and configuration:
- `alert_settings.json` - Email alert configurations
- `daily_stats.json` - Daily statistics and energy data
- `data_history.json` - Historical data for charts and trends (365 days)
- `.env` - Environment variables including JWT authentication credentials and API keys
- `ssl/server.crt` - SSL certificate file
- `ssl/server.conf` - SSL certificate configuration

⚠️ **CRITICAL:** Backups contain your login credentials, API keys, and SSL certificates. Store securely!

---

## 🔄 Automated Backups

### Daily Automatic Backups
Backups run automatically every day at **2:00 AM** via PM2 cron job.

Check the backup schedule status:
```bash
pm2 list
pm2 info solar-backup
```

### Manual Backup
Create a backup anytime:
```bash
npm run backup
```

Or directly:
```bash
node backup.js
```

### Backup Location
All backups are stored in: `/Users/jmahon/Documents/Battery/backups/`

Each backup is timestamped: `backup_2025-10-10T21-48-38/`

### Backup Retention
- Automatically keeps the **30 most recent backups**
- Older backups are automatically deleted
- Each backup includes metadata file (`backup_info.json`)

---

## 🔐 What Gets Backed Up

### Data Files (3 files)
- `alert_settings.json` - Email alert configurations
- `daily_stats.json` - Daily energy statistics
- `data_history.json` - Historical chart data (365 days)

### Authentication & Security (1 file)
- `.env` file containing:
  - `JWT_SECRET` - JWT token signing key
  - `ADMIN_USERNAME` - Login username
  - `ADMIN_PASSWORD_HASH` - Encrypted login password
  - `SENDGRID_API_KEY` - Email API key
  - `IFTTT_WEBHOOK_KEY` - Automation webhook key
  - `MQTT_BROKER` - MQTT server configuration

### SSL Certificates (2 files)
- `ssl/server.crt` - SSL certificate file (HTTPS)
- `ssl/server.conf` - SSL certificate configuration

---

## 📥 Restore Process

### Interactive Restore
Run the restore script to see available backups:
```bash
npm run restore
```

Follow the prompts to select which backup to restore.

### Quick Restore (Latest Backup)
Restore the most recent backup without prompts:
```bash
node restore.js 1
```

### Restore Specific Backup
```bash
node restore.js 2   # Restores the 2nd most recent backup
node restore.js 3   # Restores the 3rd most recent backup
```

### After Restore
**Important:** Restart the application after restoring:
```bash
pm2 restart solar-dashboard
```

---

## 🛡️ Safety Features

### Pre-Restore Backup
Before any restore operation, the current files are automatically backed up to:
```
/Users/jmahon/Documents/Battery/backups/before_restore_[timestamp]/
```

This allows you to undo a restore if needed.

### Backup Contents
Each backup folder contains:
- All data files (alert_settings.json, daily_stats.json, data_history.json)
- `.env` file with authentication credentials and API keys
- `backup_info.json` - Metadata about the backup (timestamp, version, file count)

---

## 🔑 Authentication After Restore

### Important: Login Credentials from Backup

When you restore a backup, **the login credentials from that backup are restored**.

**What this means:**
- If you changed your password after the backup was created
- The restore will bring back the OLD password from the backup
- You must use the OLD password to login after restore

### Example Scenario:
1. **October 1:** Password is `OldPassword123!`
2. **October 5:** Backup created (contains `OldPassword123!`)
3. **October 10:** You change password to `NewPassword456!`
4. **October 15:** System crashes, you restore October 5 backup
5. **Result:** Password is now `OldPassword123!` again (from the backup)

### Password Recovery Using Backups

**If You Forget Your Password:**

**Option 1: Restore Recent Backup**
```bash
cd /Users/jmahon/Documents/Battery
npm run restore
# Select most recent backup
pm2 restart solar-dashboard
# Login with password from that backup
```

**Option 2: Generate New Password**
```bash
cd /Users/jmahon/Documents/Battery
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('NewPassword123!', 10, (err, hash) => { console.log(hash); });"
# Copy the hash
nano .env
# Update ADMIN_PASSWORD_HASH
pm2 restart solar-dashboard
```

---

## 🛡️ Security Best Practices

### Protect Your Backups

✅ **DO:**
- Store backups in encrypted locations
- Limit access to backup directory: `chmod 700 backups/`
- Use encrypted external drives for off-site backups
- Keep backups secure (they contain login credentials!)
- Test restores regularly

❌ **DON'T:**
- Never commit backups to git (already in .gitignore)
- Never email backups unencrypted
- Never store in public cloud without encryption
- Never share backup folder (contains passwords!)

### Backup Directory Permissions

```bash
# Secure the backup directory
chmod 700 /Users/jmahon/Documents/Battery/backups

# Verify permissions
ls -la /Users/jmahon/Documents/Battery/ | grep backups
# Should show: drwx------  (700)
```

---

## 📊 Common Tasks

### View All Backups
```bash
ls -lht backups/
```

### Check Backup Size
```bash
du -sh backups/
```

### Manual Cleanup (if needed)
```bash
# Remove backups older than 30 days
find backups/ -name "backup_*" -type d -mtime +30 -exec rm -rf {} \;
```

### Backup Before Updates
Before updating the application or making major changes:
```bash
npm run backup
```

### Export Backup (for off-site storage)
```bash
# Create a compressed archive
tar -czf solar-backup-$(date +%Y%m%d).tar.gz backups/

# Copy to external drive or cloud storage
cp solar-backup-*.tar.gz /path/to/external/drive/
```

### Restore from Exported Backup
```bash
# Extract the archive
tar -xzf solar-backup-20251010.tar.gz

# Run restore
npm run restore
```

---

## 📈 Monitoring

### Check Last Backup Time
```bash
ls -lt backups/ | head -n 2
```

### View Backup Logs
```bash
pm2 logs solar-backup
```

### Verify Backup Integrity
```bash
# Check if backup contains all files
ls -lh backups/backup_2025-10-10T21-48-38/
```

### Check What's in a Backup
```bash
ls -lh /Users/jmahon/Documents/Battery/backups/backup_2025-10-10T22-28-15/
```

Output:
```
-rw-r--r--  alert_settings.json
-rw-r--r--  backup_info.json
-rw-r--r--  daily_stats.json
-rw-r--r--  data_history.json
-rw-r--r--  .env                ← Contains authentication!
```

---

## 🚨 Emergency Recovery Scenarios

### Scenario 1: Forgot Password
**Solution:** Restore most recent backup (contains your password)
```bash
npm run restore
# Select backup #1 (most recent)
pm2 restart solar-dashboard
# Login with password from that backup date
```

### Scenario 2: Accidentally Changed Password
**Solution:** Restore backup from before password change
```bash
npm run restore
# Select older backup from before change
pm2 restart solar-dashboard
```

### Scenario 3: Complete System Failure
**Solution:** Full restore from backup
```bash
cd /Users/jmahon/Documents/Battery
npm run restore
# Select most recent backup
pm2 restart solar-dashboard
# Everything restored: data + credentials
```

### Scenario 4: Moving to New Server
**Solution:** Copy backup and restore on new server
```bash
# On old server:
npm run backup
scp -r backups/backup_latest/ user@newserver:/path/

# On new server:
cd /path/to/app
mkdir -p backups
mv /path/backup_latest backups/
npm run restore
pm2 start app.js --name "solar-dashboard"
```

---

## 🔧 Troubleshooting

### Backup Fails
1. Check disk space: `df -h`
2. Verify file permissions: `ls -l *.json`
3. Check PM2 logs: `pm2 logs solar-backup --err`

### Restore Fails
1. Verify backup exists: `ls backups/`
2. Check file permissions
3. Ensure application is running: `pm2 status`

### Automated Backup Not Running
```bash
# Check PM2 cron status
pm2 info solar-backup

# Restart the backup job
pm2 restart solar-backup

# Save PM2 configuration
pm2 save
```

---

## 📚 Best Practices

1. **Test restores regularly** - Verify backups are working
2. **Keep off-site backups** - Export weekly backups to cloud storage
3. **Monitor backup size** - Large growth may indicate issues
4. **Backup before updates** - Always backup before upgrading
5. **Document changes** - Note any configuration changes made

---

## 🎯 Quick Commands

```bash
# Create backup
npm run backup

# Restore latest backup
node restore.js 1

# List backups
ls -lt backups/ | head

# Check what's in latest backup
ls -lh backups/$(ls -t backups | grep backup_ | head -1)/

# Verify .env in backup
cat backups/$(ls -t backups | grep backup_ | head -1)/.env | grep ADMIN

# Restart after restore
pm2 restart solar-dashboard

# Check app status
pm2 status

# View credentials (current)
cat .env | grep ADMIN

# Secure backups
chmod 700 backups/
```

---

**Last Updated:** October 13, 2025  
**Version:** 8.20.0
