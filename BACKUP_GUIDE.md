# Backup and Recovery Guide

This guide explains how to backup and restore your Solar Dashboard data.

## Overview

The backup system protects your critical data files:
- `alert_settings.json` - Email alert configurations
- `daily_stats.json` - Daily statistics and energy data
- `data_history.json` - Historical data for charts and trends
- **`.env` - Environment variables including:**
  - **JWT authentication credentials** (JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH)
  - **API keys** (SendGrid, IFTTT)
  - **MQTT broker configuration**
- **`ssl/server.crt` - SSL certificate file**
- **`ssl/server.conf` - SSL certificate configuration**

⚠️ **CRITICAL:** Backups contain your login credentials, API keys, and SSL certificates. Store securely!

## Automated Backups

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

## Restore Process

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

## Safety Features

### Pre-Restore Backup
Before any restore operation, the current files are automatically backed up to:
```
/Users/jmahon/Documents/Battery/backups/before_restore_[timestamp]/
```

This allows you to undo a restore if needed.

### Backup Contents
Each backup folder contains:
- All data files (alert_settings.json, daily_stats.json, data_history.json)
- `backup_info.json` - Metadata about the backup (timestamp, version, file count)

## Common Tasks

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

## Monitoring

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

## Troubleshooting

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

## Best Practices

1. **Test restores regularly** - Verify backups are working
2. **Keep off-site backups** - Export weekly backups to cloud storage
3. **Monitor backup size** - Large growth may indicate issues
4. **Backup before updates** - Always backup before upgrading
5. **Document changes** - Note any configuration changes made

## Emergency Recovery

If all backups are corrupted or lost:

1. Stop the application: `pm2 stop solar-dashboard`
2. Check for any `.json.bak` files
3. Review PM2 logs for last known good data
4. Contact support if needed

## Backup Script Details

### Backup Script (`backup.js`)
- Creates timestamped backup folders
- Copies all data files
- Generates metadata file
- Auto-cleans old backups (keeps 30)

### Restore Script (`restore.js`)
- Lists available backups with timestamps
- Interactive or command-line selection
- Safety backup before restore
- Verifies file integrity

## Support

For issues or questions:
- Check PM2 logs: `pm2 logs`
- Review application logs
- Verify file permissions
- Check disk space

---

**Last Updated:** October 10, 2025  
**Version:** 7.1.0

