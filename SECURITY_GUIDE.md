# 🔐 Security Guide

Complete guide for authentication, SSL setup, and security best practices for the SolarAssistant Dashboard.

---

## 🔑 JWT Authentication

### Overview

Your Solar Dashboard is protected with JWT (JSON Web Token) based authentication. All routes except the login page require authentication to access.

### What's Protected

**All Dashboard Routes:**
- ✅ Main Dashboard (`/`) - Redirects to `/login` if not authenticated
- ✅ Data API (`/data`) - Returns 401 if not authenticated
- ✅ Historical Data (`/data/history`) - Requires authentication
- ✅ Settings API (`/settings/alerts`) - Requires authentication
- ✅ All POST endpoints - Require authentication

**Public Routes:**
- ✅ Login Page (`/login`) - Accessible to everyone
- ✅ Login API (`/api/auth/login`) - Accessible to everyone

### How to Login

**Via Browser:**
1. Navigate to `https://localhost:3434`
2. You'll be automatically redirected to `/login`
3. Enter your username and password
4. Click "Login"
5. You'll be redirected to the dashboard

**Session Duration:**
- **Default:** 7 days
- Configured in `.env` as `JWT_EXPIRES_IN=7d`

---

## 🔧 Configuration

### Environment Variables (.env)

```bash
# JWT Authentication
JWT_SECRET=your-super-secret-jwt-key-here
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=$2b$10$your-bcrypt-hash-here
JWT_EXPIRES_IN=7d

# API Keys
SENDGRID_API_KEY=SG.your-sendgrid-api-key
IFTTT_WEBHOOK_KEY=your-ifttt-webhook-key

# MQTT Configuration
MQTT_BROKER=mqtt://192.168.1.228:1883

# Server Configuration
PORT=3434
```

### Generate Password Hash

To create a new password hash:
```bash
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('YourNewPassword123!', 10, (err, hash) => { console.log('Hash:', hash); });"
```

### Update Password

1. Generate new hash using command above
2. Update `ADMIN_PASSWORD_HASH` in `.env`
3. Restart application: `pm2 restart solar-dashboard`

---

## 🔒 SSL/HTTPS Setup

### Overview

Your Solar Dashboard runs with HTTPS encryption using a self-signed SSL certificate. This provides secure communication between your browser and the dashboard.

### SSL Certificate Details

**Certificate Information:**
- **Private Key**: `ssl/server.key` (2048-bit RSA)
- **Certificate**: `ssl/server.crt` (Self-signed, valid for 1 year)
- **Configuration**: `ssl/server.conf` (Certificate configuration)

**Certificate Details:**
```
Subject: C=US, ST=CA, L=San Francisco, O=Solar Dashboard, OU=IT Department, CN=localhost
Valid From: October 10, 2025
Valid Until: October 10, 2026
Supported Domains: localhost, 127.0.0.1, *.local
Supported IPs: 127.0.0.1, ::1 (IPv6)
```

### HTTPS Server Configuration

- **Protocol**: HTTPS only (HTTP disabled)
- **Port**: 3434
- **Encryption**: TLS 1.2/1.3
- **Certificate**: Self-signed (browser will show warning)

### How to Access

**Primary Access:**
```
https://localhost:3434
```

**Alternative Access Methods:**
```
https://127.0.0.1:3434
https://[::1]:3434
```

**Login Page:**
```
https://localhost:3434/login
```

### Browser Security Warning

Since this is a self-signed certificate, your browser will show a security warning:

1. **Chrome/Edge:** Click "Advanced" → "Proceed to localhost (unsafe)"
2. **Firefox:** Click "Advanced" → "Accept the Risk and Continue"
3. **Safari:** Click "Show Details" → "visit this website"

This is normal for self-signed certificates and safe for local development.

---

## 🔄 Environment Variables Migration

### What Was Changed

**Before (Hardcoded):**
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

**After (Environment Variables):**
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

### Migrated Configuration

**API Keys Moved to .env:**
- ✅ SendGrid API Key
- ✅ IFTTT Webhook Key  
- ✅ MQTT Broker URL
- ✅ Application Port
- ✅ JWT Secret
- ✅ Admin Credentials

### Benefits of Environment Variables

1. **Security**: Sensitive data not in source code
2. **Flexibility**: Easy configuration changes
3. **Version Control**: Can safely commit code without secrets
4. **Deployment**: Easy configuration for different environments
5. **Backup**: All configuration in one `.env` file

---

## 🛡️ Security Best Practices

### File Permissions

**Secure .env file:**
```bash
chmod 600 .env
```

**Secure backup directory:**
```bash
chmod 700 backups/
```

**Verify permissions:**
```bash
ls -la | grep -E "(\.env|backups)"
# Should show: -rw------- .env and drwx------ backups
```

### Network Security

**Firewall Configuration:**
- Only allow access from trusted networks
- Consider VPN for remote access
- Use strong passwords for all accounts

**MQTT Security:**
- Use MQTT over TLS when possible
- Implement MQTT authentication
- Use network segmentation

### API Key Management

**Rotation Schedule:**
- Rotate API keys quarterly
- Monitor for unauthorized usage
- Use different keys for different environments

**Storage:**
- Never commit API keys to version control
- Use encrypted storage for backups
- Implement key versioning

### Authentication Security

**Password Requirements:**
- Minimum 12 characters
- Mix of uppercase, lowercase, numbers, symbols
- No dictionary words
- Unique per service

**Session Management:**
- Regular session rotation
- Secure cookie settings
- Logout on inactivity

---

## 🚨 Security Monitoring

### Log Monitoring

**Check Authentication Logs:**
```bash
pm2 logs solar-dashboard | grep -i "auth\|login\|jwt"
```

**Monitor Failed Login Attempts:**
```bash
pm2 logs solar-dashboard | grep -i "unauthorized\|invalid\|failed"
```

### Backup Security

**Verify Backup Encryption:**
```bash
# Check if .env is in backups (should be)
ls -la backups/backup_*/ | grep "\.env"
```

**Test Restore Security:**
```bash
# Verify restore doesn't expose credentials
npm run restore
# Check that .env is restored correctly
```

### SSL Certificate Monitoring

**Check Certificate Expiry:**
```bash
openssl x509 -in ssl/server.crt -text -noout | grep -A2 "Validity"
```

**Renew Certificate:**
```bash
# Certificate expires annually - renew before expiry
openssl req -new -x509 -key ssl/server.key -out ssl/server.crt -days 365
```

---

## 🔧 Troubleshooting

### Authentication Issues

**Can't Login:**
1. Check username/password in `.env`
2. Verify JWT_SECRET is set
3. Check PM2 logs for errors
4. Try generating new password hash

**Session Expires Too Quickly:**
1. Check `JWT_EXPIRES_IN` setting
2. Verify system time is correct
3. Check for clock skew issues

### SSL Issues

**Certificate Errors:**
1. Verify certificate files exist
2. Check file permissions
3. Ensure certificate hasn't expired
4. Try regenerating certificate

**Browser Won't Connect:**
1. Check if port 3434 is accessible
2. Verify firewall settings
3. Try different browser
4. Check for proxy interference

### API Key Issues

**Email Alerts Not Working:**
1. Verify SendGrid API key in `.env`
2. Check API key permissions
3. Test with SendGrid dashboard
4. Check PM2 logs for errors

**IFTTT Integration Not Working:**
1. Verify IFTTT webhook key in `.env`
2. Test webhook URL manually
3. Check IFTTT applet configuration
4. Verify network connectivity

---

## 📋 Security Checklist

### Initial Setup
- [ ] Change default password
- [ ] Set strong JWT_SECRET
- [ ] Configure SSL certificate
- [ ] Set proper file permissions
- [ ] Enable firewall rules

### Regular Maintenance
- [ ] Rotate API keys quarterly
- [ ] Monitor authentication logs
- [ ] Check certificate expiry
- [ ] Update passwords annually
- [ ] Review access logs

### Backup Security
- [ ] Verify .env in backups
- [ ] Test restore process
- [ ] Secure backup storage
- [ ] Encrypt off-site backups
- [ ] Document recovery procedures

---

## 🆘 Emergency Procedures

### Compromised Credentials

1. **Immediately change password:**
   ```bash
   node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('NewSecurePassword123!', 10, (err, hash) => { console.log(hash); });"
   ```

2. **Update .env file:**
   ```bash
   nano .env
   # Update ADMIN_PASSWORD_HASH with new hash
   ```

3. **Restart application:**
   ```bash
   pm2 restart solar-dashboard
   ```

### Compromised API Keys

1. **Generate new API keys** from service providers
2. **Update .env file** with new keys
3. **Test all integrations** (email, IFTTT)
4. **Monitor for unauthorized usage**

### System Compromise

1. **Stop the application:**
   ```bash
   pm2 stop solar-dashboard
   ```

2. **Restore from clean backup:**
   ```bash
   npm run restore
   # Select backup from before compromise
   ```

3. **Change all credentials:**
   - Password
   - API keys
   - JWT secret

4. **Restart with new credentials:**
   ```bash
   pm2 start solar-dashboard
   ```

---

**Last Updated:** October 13, 2025  
**Version:** 8.20.0
