# 🔐 Security Migration - Environment Variables

## Overview

Successfully migrated sensitive API keys and configuration from hardcoded values to environment variables for improved security.

---

## ✅ What Was Changed

### 1. **API Keys Moved to .env File**

The following sensitive credentials are now stored in `.env` instead of being hardcoded:

- ✅ SendGrid API Key
- ✅ IFTTT Webhook Key  
- ✅ MQTT Broker URL
- ✅ Application Port
- ✅ Admin Password (for future use)

### 2. **Code Changes in app.js**

**Before:**
```javascript
const PORT = 3434;
const MQTT_BROKER = 'mqtt://192.168.1.228:1883';

let alertSettings = {
  sendgridApiKey: 'SG.XG0XGN...',  // Hardcoded!
  chargerControl: {
    iftttWebhookKey: 'nvapys...'   // Hardcoded!
  }
};
```

**After:**
```javascript
require('dotenv').config();

const PORT = process.env.PORT || 3434;
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://192.168.1.228:1883';

let alertSettings = {
  sendgridApiKey: process.env.SENDGRID_API_KEY || '',
  chargerControl: {
    iftttWebhookKey: process.env.IFTTT_WEBHOOK_KEY || ''
  }
};
```

### 3. **Enhanced Security in Settings Management**

- API keys from `.env` **always take precedence** over saved settings
- API keys are **never saved** to `alert_settings.json`
- Settings file only stores user preferences (email addresses, thresholds, etc.)

### 4. **Updated .gitignore**

Protected files from being committed to version control:
```gitignore
# Environment variables
.env
.env.local

# Data files (contain sensitive information and system state)
alert_settings.json
daily_stats.json
data_history.json
```

---

## 📁 New Files Created

### `.env` (Production - NEVER commit!)
Contains your actual API keys and configuration:
```env
SENDGRID_API_KEY=SG.XG0XGNSGRbaa3zHA4CWvGg...
IFTTT_WEBHOOK_KEY=nvapysHalPxSIDzMBIQYbR2LGTZ5jC3w...
MQTT_BROKER=mqtt://192.168.1.228:1883
ADMIN_PASSWORD=YourSecurePassword123!
PORT=3434
```

### `.env.example` (Template - Safe to commit)
Template for other users/deployments:
```env
SENDGRID_API_KEY=your_sendgrid_api_key_here
IFTTT_WEBHOOK_KEY=your_ifttt_webhook_key_here
MQTT_BROKER=mqtt://your.mqtt.broker:1883
ADMIN_PASSWORD=your_secure_password_here
PORT=3434
```

---

## 🚀 How It Works

### Application Startup Flow

1. **dotenv loads `.env` file**
   ```javascript
   require('dotenv').config();
   ```

2. **Environment variables set default values**
   ```javascript
   alertSettings = {
     sendgridApiKey: process.env.SENDGRID_API_KEY || ''
   };
   ```

3. **Load saved user preferences**
   ```javascript
   loadAlertSettings(); // Loads from alert_settings.json
   ```

4. **Environment variables override**
   ```javascript
   // API keys ALWAYS come from .env (security!)
   if (process.env.SENDGRID_API_KEY) {
     alertSettings.sendgridApiKey = process.env.SENDGRID_API_KEY;
   }
   ```

5. **Save excludes API keys**
   ```javascript
   // When saving settings, API keys are excluded
   const settingsToSave = {
     ...alertSettings,
     sendgridApiKey: undefined,  // Not saved to file
     chargerControl: {
       ...alertSettings.chargerControl,
       iftttWebhookKey: undefined  // Not saved to file
     }
   };
   ```

---

## 🔧 Configuration Management

### Modifying Environment Variables

To update API keys or configuration:

1. Stop the application:
   ```bash
   pm2 stop solar-dashboard
   ```

2. Edit the `.env` file:
   ```bash
   nano /Users/jmahon/Documents/Battery/.env
   ```

3. Restart the application:
   ```bash
   pm2 restart solar-dashboard
   ```

### Modifying User Preferences

User preferences (emails, thresholds) can be changed:
- Via the dashboard settings UI (automatically saved)
- By editing `alert_settings.json` manually
- **Note:** API keys in this file will be ignored!

---

## 🛡️ Security Benefits

### Before Migration
❌ API keys visible in source code  
❌ Keys could be committed to git  
❌ Keys visible in `alert_settings.json`  
❌ Hard to change keys per environment  
❌ Keys exposed in code reviews  

### After Migration
✅ API keys in `.env` file only  
✅ `.env` excluded from git  
✅ Keys never saved to settings file  
✅ Easy per-environment configuration  
✅ Keys protected from exposure  

---

## 📋 Deployment Checklist

When deploying to a new environment:

- [ ] Copy `.env.example` to `.env`
- [ ] Edit `.env` with your API keys
- [ ] Ensure `.env` has correct permissions (600)
- [ ] Verify `.env` is in `.gitignore`
- [ ] Test application loads environment variables
- [ ] Verify API keys work (check logs)
- [ ] Confirm settings save/load correctly

### Setting File Permissions
```bash
chmod 600 /Users/jmahon/Documents/Battery/.env
```

---

## 🔍 Verification

### Check Environment Variables Are Loaded

```bash
# Should show MASKED values (PM2 hides sensitive env vars)
pm2 env 0
```

### Test API Endpoints

```bash
# Test dashboard loads
curl http://localhost:3434

# Test data endpoint
curl http://localhost:3434/data

# Check settings endpoint
curl http://localhost:3434/settings
```

### Verify Logs

```bash
pm2 logs solar-dashboard --lines 50
```

Look for:
- ✅ "📂 Loaded historical data"
- ✅ "📊 Loaded daily stats"
- ✅ "📧 Loaded alert settings"
- ✅ "🔌 Connecting to MQTT broker"
- ❌ No "API key undefined" errors

---

## 🚨 Troubleshooting

### Problem: "SendGrid API key not found"

**Solution:** Check `.env` file exists and contains `SENDGRID_API_KEY`
```bash
cat /Users/jmahon/Documents/Battery/.env | grep SENDGRID
```

### Problem: MQTT connection fails

**Solution:** Verify MQTT_BROKER in `.env`
```bash
cat /Users/jmahon/Documents/Battery/.env | grep MQTT_BROKER
```

### Problem: Application won't start

**Solution:**
1. Check for syntax errors in `.env`
2. Ensure dotenv package is installed: `npm list dotenv`
3. Check PM2 logs: `pm2 logs solar-dashboard --err`

### Problem: Old API key still being used

**Solution:** The old `alert_settings.json` may have cached keys. Either:
1. Delete `alert_settings.json` (will regenerate)
2. Edit it and remove `sendgridApiKey` and `iftttWebhookKey` fields

---

## 📦 Dependencies Added

```json
{
  "dotenv": "^16.x.x"
}
```

Installed via:
```bash
npm install dotenv
```

---

## 🔄 Backup Considerations

### What to Backup

**DO Backup:**
- `.env` file (securely, encrypted storage)
- `alert_settings.json` (user preferences)
- `data_history.json` (historical data)
- `daily_stats.json` (daily statistics)

**DON'T Commit to Git:**
- `.env` file (use `.env.example` instead)
- `alert_settings.json` (may contain email addresses)
- `data_history.json` (large, system-specific)
- `daily_stats.json` (system-specific)

### Backup Location

Backups are automatically created daily at 2 AM via PM2 cron:
```bash
ls -lh /Users/jmahon/Documents/Battery/backups/
```

**Note:** `.env` file is NOT included in automatic backups. Back it up separately and securely!

---

## 📝 Migration Summary

| Item | Before | After | Status |
|------|--------|-------|--------|
| SendGrid API Key | Hardcoded in app.js | Environment variable | ✅ Migrated |
| IFTTT Webhook Key | Hardcoded in app.js | Environment variable | ✅ Migrated |
| MQTT Broker | Hardcoded in app.js | Environment variable | ✅ Migrated |
| Port | Hardcoded | Environment variable | ✅ Migrated |
| Admin Password | Not configured | Environment variable | ✅ Added |
| dotenv Package | Not installed | Installed | ✅ Added |
| .env File | Did not exist | Created | ✅ Created |
| .env.example | Did not exist | Created | ✅ Created |
| .gitignore | Partial | Complete | ✅ Updated |
| Security | Low | High | ✅ Improved |

---

## 🎯 Best Practices Going Forward

1. **Never commit `.env` to version control**
2. **Rotate API keys periodically** (every 90 days recommended)
3. **Use different keys per environment** (dev/staging/prod)
4. **Backup `.env` securely** (encrypted, separate from code)
5. **Document which environment variables are required**
6. **Use `.env.example` for new deployments**
7. **Set restrictive file permissions** on `.env` (chmod 600)
8. **Review logs for exposed secrets** (no keys should appear in logs)

---

## 🔗 Related Documentation

- **Backup Guide:** `BACKUP_GUIDE.md`
- **Restore Guide:** `RESTORE.md`
- **Main README:** `README.md`

---

**Migration Date:** October 10, 2025  
**Version:** 7.1.0  
**Status:** ✅ Completed and Tested

