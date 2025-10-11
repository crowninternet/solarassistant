# 🔒 SSL/HTTPS Setup Guide

## Overview

Your Solar Dashboard now runs with HTTPS encryption using a self-signed SSL certificate. This provides secure communication between your browser and the dashboard.

---

## ✅ What Was Implemented

### SSL Certificate Created
- **Private Key**: `ssl/server.key` (2048-bit RSA)
- **Certificate**: `ssl/server.crt` (Self-signed, valid for 1 year)
- **Configuration**: `ssl/server.conf` (Certificate configuration)

### Certificate Details
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

---

## 🚀 How to Access

### Primary Access
```
https://localhost:3434
```

### Alternative Access Methods
```
https://127.0.0.1:3434
https://[::1]:3434
```

### Login Page
```
https://localhost:3434/login
```

---

## ⚠️ Browser Security Warning

### Expected Behavior
When you first visit the HTTPS site, your browser will show a security warning because it's a self-signed certificate.

### How to Proceed (Chrome/Safari/Firefox)
1. **Click "Advanced"** (or "Show Details")
2. **Click "Proceed to localhost (unsafe)"** or "Accept the Risk and Continue"
3. The site will load normally after accepting the certificate

### Why This Happens
- Self-signed certificates aren't verified by a trusted Certificate Authority
- Browsers show warnings for security
- This is normal for local development/testing

---

## 🔧 Technical Details

### Files Created
```
ssl/
├── server.key          # Private key (keep secure!)
├── server.crt          # Certificate file
├── server.csr          # Certificate signing request
└── server.conf         # Certificate configuration
```

### Security Features
- **2048-bit RSA encryption**
- **SHA-256 signature algorithm**
- **Subject Alternative Names (SAN)** for multiple domains
- **IPv4 and IPv6 support**
- **Local domain wildcard (*.local)**

### Server Configuration
The Express.js server now uses:
```javascript
const https = require('https');
const fs = require('fs');

const SSL_OPTIONS = {
  key: fs.readFileSync('./ssl/server.key'),
  cert: fs.readFileSync('./ssl/server.crt')
};

https.createServer(SSL_OPTIONS, app).listen(PORT, ...);
```

---

## 🔄 Certificate Renewal

### When to Renew
The certificate expires on **October 10, 2026**. You'll need to renew it before then.

### How to Renew
```bash
cd /Users/jmahon/Documents/Battery

# Generate new certificate (same process)
openssl req -new -key ssl/server.key -out ssl/server.csr -config ssl/server.conf
openssl x509 -req -in ssl/server.csr -signkey ssl/server.key -out ssl/server.crt -days 365 -extensions v3_req -extfile ssl/server.conf

# Restart the application
pm2 restart solar-dashboard
```

### Automated Renewal Script
You can create a renewal script:
```bash
#!/bin/bash
# ssl/renew.sh
cd /Users/jmahon/Documents/Battery
openssl req -new -key ssl/server.key -out ssl/server.csr -config ssl/server.conf
openssl x509 -req -in ssl/server.csr -signkey ssl/server.key -out ssl/server.crt -days 365 -extensions v3_req -extfile ssl/server.conf
pm2 restart solar-dashboard
echo "SSL certificate renewed successfully!"
```

---

## 🛡️ Security Considerations

### What's Protected
✅ **Data in transit** - All communication encrypted
✅ **Login credentials** - Username/password encrypted
✅ **API requests** - All API calls encrypted
✅ **Dashboard data** - Real-time data encrypted

### What's NOT Protected
❌ **Certificate validation** - Self-signed, not verified by CA
❌ **Man-in-the-middle attacks** - Possible if attacker has network access
❌ **Browser warnings** - Users must manually accept certificate

### For Production Use
If deploying to production, consider:
- **Let's Encrypt** for free, trusted certificates
- **Commercial SSL certificates** from trusted CAs
- **Certificate validation** in browsers
- **HSTS headers** for forced HTTPS

---

## 📱 Mobile/Network Access

### Local Network Access
To access from other devices on your network:

1. **Find your computer's IP address:**
   ```bash
   ifconfig | grep "inet " | grep -v 127.0.0.1
   ```

2. **Update certificate to include your IP:**
   Edit `ssl/server.conf` and add your IP to the `[alt_names]` section:
   ```
   IP.3 = 192.168.1.XXX  # Your actual IP
   ```

3. **Regenerate certificate:**
   ```bash
   openssl req -new -key ssl/server.key -out ssl/server.csr -config ssl/server.conf
   openssl x509 -req -in ssl/server.csr -signkey ssl/server.key -out ssl/server.crt -days 365 -extensions v3_req -extfile ssl/server.conf
   pm2 restart solar-dashboard
   ```

4. **Access from mobile/other devices:**
   ```
   https://192.168.1.XXX:3434
   ```

### Mobile Browser Warnings
Mobile browsers will also show security warnings. The process is similar:
- **iOS Safari**: Tap "Advanced" → "Visit this website"
- **Android Chrome**: Tap "Advanced" → "Proceed to site"

---

## 🔍 Troubleshooting

### Common Issues

#### "Connection Refused"
```bash
# Check if PM2 is running
pm2 status

# Check if port 3434 is in use
lsof -i :3434

# Restart if needed
pm2 restart solar-dashboard
```

#### "Certificate Error"
```bash
# Verify certificate files exist
ls -la ssl/

# Check certificate validity
openssl x509 -in ssl/server.crt -text -noout | grep "Not After"
```

#### "HTTPS Not Working"
```bash
# Check PM2 logs
pm2 logs solar-dashboard

# Look for HTTPS startup messages
pm2 logs solar-dashboard | grep "HTTPS"
```

### Testing HTTPS
```bash
# Test with curl (ignore certificate warnings)
curl -k https://localhost:3434 -I

# Test with openssl
openssl s_client -connect localhost:3434 -servername localhost
```

---

## 📋 Quick Reference

### URLs
- **Dashboard**: https://localhost:3434
- **Login**: https://localhost:3434/login
- **API**: https://localhost:3434/data

### Commands
```bash
# Check status
pm2 status

# View logs
pm2 logs solar-dashboard

# Restart with SSL
pm2 restart solar-dashboard

# Test HTTPS
curl -k https://localhost:3434 -I
```

### Files
- **Private Key**: `ssl/server.key` (SECURE - don't share!)
- **Certificate**: `ssl/server.crt` (can be shared)
- **Config**: `ssl/server.conf` (can be shared)

---

## ✅ Verification Checklist

After SSL setup, verify:

- [ ] HTTPS site loads at https://localhost:3434
- [ ] Browser shows security warning (expected)
- [ ] Can accept certificate and proceed
- [ ] Login page works over HTTPS
- [ ] Dashboard loads after login
- [ ] API endpoints work over HTTPS
- [ ] HTTP redirects to HTTPS (or fails as expected)
- [ ] Certificate valid for 1 year
- [ ] PM2 shows HTTPS startup messages

---

## 🎯 Next Steps

### Optional Enhancements
1. **HSTS Headers** - Force HTTPS in browsers
2. **Certificate Pinning** - Enhanced security
3. **Let's Encrypt** - Trusted certificates
4. **Reverse Proxy** - Nginx/Apache with SSL termination

### Monitoring
- **Certificate expiration** - Set calendar reminder for renewal
- **HTTPS status** - Monitor in PM2 logs
- **Browser compatibility** - Test across different browsers

---

**Last Updated**: October 10, 2025  
**Certificate Expires**: October 10, 2026  
**Status**: ✅ HTTPS Active

Your Solar Dashboard is now secured with HTTPS encryption! 🔒
