# 🔐 JWT Authentication Guide

## Overview

Your Solar Dashboard is now protected with JWT (JSON Web Token) based authentication. All routes except the login page require authentication to access.

---

## ✅ What's Protected

### All Dashboard Routes:
- ✅ Main Dashboard (`/`) - Redirects to `/login` if not authenticated
- ✅ Data API (`/data`) - Returns 401 if not authenticated
- ✅ Historical Data (`/data/history`) - Requires authentication
- ✅ Settings API (`/settings/alerts`) - Requires authentication
- ✅ All POST endpoints - Require authentication

### Public Routes:
- ✅ Login Page (`/login`) - Accessible to everyone
- ✅ Login API (`/api/auth/login`) - Accessible to everyone

---

## 🔑 Default Credentials

**Username:** `admin`  
**Password:** `YourSecurePassword123!`

⚠️ **IMPORTANT:** Change these credentials immediately in production!

---

## 🚀 How to Login

### Via Browser:
1. Navigate to `http://localhost:3434`
2. You'll be automatically redirected to `/login`
3. Enter your username and password
4. Click "Login"
5. You'll be redirected to the dashboard

### Session Duration:
- **Default:** 7 days
- Configured in `.env` as `JWT_EXPIRES_IN=7d`

---

## 🔧 Configuration

### Environment Variables (.env)

```bash
# JWT Authentication
JWT_SECRET=solar_dashboard_jwt_secret_key_2025_change_this_in_production
JWT_EXPIRES_IN=7d

# Default Admin User
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=$2b$10$DTFWcgMGMT8s95iwcCgls.pGtDL1ryNHGnJSfzLyVtFxcxypDc.S6
```

### Changing the Password

1. **Generate a new password hash:**
   ```bash
   node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('YOUR_NEW_PASSWORD', 10, (err, hash) => { console.log(hash); });"
   ```

2. **Update .env file:**
   ```bash
   nano /Users/jmahon/Documents/Battery/.env
   # Update ADMIN_PASSWORD_HASH with the new hash
   ```

3. **Restart the application:**
   ```bash
   pm2 restart solar-dashboard
   ```

### Changing the Username

1. **Update .env file:**
   ```bash
   nano /Users/jmahon/Documents/Battery/.env
   # Update ADMIN_USERNAME
   ```

2. **Restart the application:**
   ```bash
   pm2 restart solar-dashboard
   ```

### Changing JWT Secret

⚠️ **WARNING:** Changing the JWT secret will invalidate all existing tokens!

1. **Generate a strong secret:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'));"
   ```

2. **Update .env file:**
   ```bash
   JWT_SECRET=your_new_secret_here
   ```

3. **Restart the application:**
   ```bash
   pm2 restart solar-dashboard
   ```

---

## 🔒 Security Features

### HTTP-Only Cookies
- JWT tokens are stored in HTTP-only cookies
- Not accessible via JavaScript (XSS protection)
- Automatically sent with every request

### Secure Cookies (Production)
- When `NODE_ENV=production`, cookies are marked as `secure`
- Requires HTTPS in production

### SameSite Protection
- Cookies use `sameSite: 'strict'`
- Prevents CSRF attacks

### Password Hashing
- Passwords are hashed with bcrypt (10 rounds)
- Never stored in plain text
- Impossible to reverse

### Token Expiration
- Tokens automatically expire after configured duration
- Users must re-login after expiration

---

## 🎨 UI Features

### Login Page
- Clean, modern design
- Responsive (mobile-friendly)
- Error handling
- Loading states

### Dashboard Changes
- ✅ Logout button added (🚪 icon, top right)
- ✅ Settings button remains (⚙️ icon)
- ✅ Theme toggle remains (🌙/☀️ icon)

### Logout Process
1. Click the 🚪 logout button
2. Confirm logout
3. JWT cookie is cleared
4. Redirected to login page

---

## 📡 API Authentication

### For Programmatic Access:

**Login and get cookie:**
```bash
curl -X POST http://localhost:3434/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YourSecurePassword123!"}' \
  -c cookies.txt
```

**Use cookie for authenticated requests:**
```bash
curl -b cookies.txt http://localhost:3434/data
```

**Logout:**
```bash
curl -X POST http://localhost:3434/api/auth/logout -b cookies.txt
```

### Authentication Endpoints:

| Endpoint | Method | Auth Required | Description |
|----------|--------|---------------|-------------|
| `/api/auth/login` | POST | No | Login and receive JWT token |
| `/api/auth/logout` | POST | No | Logout and clear token |
| `/api/auth/check` | GET | Yes | Check if authenticated |

---

## 🔐 Security Best Practices

### DO:

✅ **Change default credentials** immediately  
✅ **Use strong passwords** (16+ characters, mixed case, numbers, symbols)  
✅ **Keep JWT_SECRET secure** (never commit to git)  
✅ **Use HTTPS in production** (required for secure cookies)  
✅ **Regularly update passwords** (every 90 days)  
✅ **Monitor login attempts** (check PM2 logs)  
✅ **Keep dependencies updated** (`npm audit fix`)  

### DON'T:

❌ **Never share credentials** via email or unencrypted channels  
❌ **Never commit .env to git** (already in .gitignore)  
❌ **Never use default credentials** in production  
❌ **Never disable authentication** without good reason  
❌ **Never log passwords** or tokens  

---

## 🚨 Troubleshooting

### Problem: "Authentication required" on all pages

**Solution:** Your JWT token may have expired or is invalid.
1. Clear browser cookies
2. Navigate to `/login`
3. Login again

### Problem: "Invalid credentials" when logging in

**Possible causes:**
1. Wrong username or password
2. Password hash in .env doesn't match password
3. ADMIN_PASSWORD_HASH is missing or incorrect

**Solution:**
```bash
# Check .env file
cat /Users/jmahon/Documents/Battery/.env | grep ADMIN

# Regenerate password hash
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('YourSecurePassword123!', 10, (err, hash) => { console.log(hash); });"

# Update .env and restart
pm2 restart solar-dashboard
```

### Problem: Can't access login page

**Check if app is running:**
```bash
pm2 status
pm2 logs solar-dashboard --lines 50
```

**Restart if needed:**
```bash
pm2 restart solar-dashboard
```

### Problem: Logout button not working

**Check browser console for errors:**
1. Open browser DevTools (F12)
2. Check Console tab
3. Click logout button
4. Look for network errors

**Common fix:**
```bash
# Clear browser cache and cookies
# Restart the application
pm2 restart solar-dashboard
```

### Problem: "Cannot POST /api/auth/login"

**Possible causes:**
1. Application not running
2. Wrong URL
3. CORS issues

**Solution:**
```bash
# Check if app is listening on port 3434
lsof -i :3434

# Restart application
pm2 restart solar-dashboard

# Check logs
pm2 logs solar-dashboard
```

---

## 📊 Monitoring

### Check Login Activity

```bash
# View PM2 logs
pm2 logs solar-dashboard

# Look for login messages
pm2 logs solar-dashboard | grep "logged"
```

Example log entries:
```
✅ User logged in: admin
✅ User logged out
```

### Check Authentication Status

```bash
# Test if endpoint requires auth
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3434/data
# Should return: 401 (Unauthorized)

# Test with authentication
curl -b cookies.txt -s -o /dev/null -w "%{http_code}\n" http://localhost:3434/data
# Should return: 200 (OK)
```

---

## 🔄 Migration from Unauthenticated

### What Changed:

**Before (v7.1.0):**
- Dashboard was publicly accessible
- No login required
- Anyone could access all endpoints

**After (v7.2.0):**
- Login required for all dashboard access
- JWT-based authentication
- Session management
- Logout functionality

### Impact:

- **Bookmarks:** Still work, but redirect to login
- **API integrations:** Need to authenticate first
- **Mobile apps:** Need to implement login flow

---

## 🔑 Password Recovery

⚠️ **No automated password recovery** - This is a single-user system.

**If you forget your password:**

1. **Stop the application:**
   ```bash
   pm2 stop solar-dashboard
   ```

2. **Generate new password hash:**
   ```bash
   node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('NewPassword123!', 10, (err, hash) => { console.log(hash); });"
   ```

3. **Update .env file:**
   ```bash
   nano /Users/jmahon/Documents/Battery/.env
   # Replace ADMIN_PASSWORD_HASH with new hash
   ```

4. **Restart application:**
   ```bash
   pm2 start solar-dashboard
   ```

---

## 🎯 Testing Authentication

### Manual Testing:

1. **Test unauthenticated access:**
   - Open incognito/private browser window
   - Go to `http://localhost:3434`
   - Should redirect to `/login`

2. **Test login:**
   - Enter credentials
   - Should redirect to dashboard

3. **Test authenticated access:**
   - Dashboard should load normally
   - All features should work

4. **Test logout:**
   - Click logout button
   - Should redirect to login
   - Dashboard should be inaccessible

### Automated Testing:

```bash
# Test script
#!/bin/bash

echo "Testing authentication..."

# Test 1: Unauthenticated access
echo "1. Testing unauthenticated access..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3434/data)
if [ "$STATUS" = "401" ]; then
    echo "✅ PASS: Data endpoint requires auth"
else
    echo "❌ FAIL: Expected 401, got $STATUS"
fi

# Test 2: Login
echo "2. Testing login..."
LOGIN=$(curl -s -X POST http://localhost:3434/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YourSecurePassword123!"}' \
  -c /tmp/test_cookies.txt)
if echo "$LOGIN" | grep -q "success"; then
    echo "✅ PASS: Login successful"
else
    echo "❌ FAIL: Login failed"
fi

# Test 3: Authenticated access
echo "3. Testing authenticated access..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/test_cookies.txt http://localhost:3434/data)
if [ "$STATUS" = "200" ]; then
    echo "✅ PASS: Authenticated access works"
else
    echo "❌ FAIL: Expected 200, got $STATUS"
fi

# Test 4: Invalid credentials
echo "4. Testing invalid credentials..."
LOGIN=$(curl -s -X POST http://localhost:3434/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"wrong"}')
if echo "$LOGIN" | grep -q "Invalid credentials"; then
    echo "✅ PASS: Invalid credentials rejected"
else
    echo "❌ FAIL: Should reject invalid credentials"
fi

echo "Testing complete!"
```

---

## 📦 Dependencies

### New Packages Added:

```json
{
  "jsonwebtoken": "^9.x.x",    // JWT token generation/verification
  "bcryptjs": "^2.x.x",        // Password hashing
  "cookie-parser": "^1.x.x"    // Cookie parsing middleware
}
```

### Installation:

```bash
npm install jsonwebtoken bcryptjs cookie-parser
```

---

## 🔄 Backup Considerations

### What's Backed Up:

The automated backup system **now includes** `.env` file with:
- JWT_SECRET
- ADMIN_USERNAME
- ADMIN_PASSWORD_HASH

⚠️ **Security Reminder:** Backups contain sensitive authentication credentials!

See `BACKUP_ENV_NOTICE.md` for details.

---

## 📚 Additional Resources

- **Security Migration:** `SECURITY_MIGRATION.md`
- **Backup Guide:** `BACKUP_GUIDE.md`
- **Restore Guide:** `RESTORE.md`
- **Main README:** `README.md`

---

## 🔐 Production Deployment

### Before Going Live:

1. ✅ Change default credentials
2. ✅ Generate strong JWT_SECRET
3. ✅ Set `NODE_ENV=production`
4. ✅ Enable HTTPS
5. ✅ Configure firewall
6. ✅ Set up monitoring
7. ✅ Test authentication thoroughly
8. ✅ Document credentials securely
9. ✅ Set up backup encryption
10. ✅ Review PM2 logs regularly

---

**Created:** October 10, 2025  
**Version:** 7.2.0  
**Status:** ✅ Implemented and Tested

